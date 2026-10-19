import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { safeJsonParse } from './safe-json.js';
import { dirname } from 'node:path';
import type {
  Action,
  Detail,
  DotUsage,
  Memory,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
  UsageReport,
  UsageSummary,
} from '../shared/types.js';

export type Claim = Task & { lease: string };
const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
  replyStyle: 'standard',
  replyLanguage: 'fr',
};
/**
 * Store — Phase C1 : isolation par compte (même contrat que WorkspaceStore).
 * Un store NON porté ne voit rien ; ses écritures lèvent. claim() est
 * l'opération système du runner : elle choisit une tâche tous comptes
 * (en respectant les réglages DE SON propriétaire) puis l'exécution se
 * fait sur le store porté par task.userId.
 */
export class Store {
  private db: DatabaseSync;
  constructor(
    pathOrDb: string | DatabaseSync,
    readonly userId: string | null = null,
  ) {
    if (typeof pathOrDb === 'string') {
      if (pathOrDb !== ':memory:')
        mkdirSync(dirname(pathOrDb), { recursive: true });
      this.db = new DatabaseSync(pathOrDb);
    } else {
      this.db = pathOrDb;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS setup_telemetry (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (userId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER, user_id TEXT);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT, user_id TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS attachment_users (attachmentId TEXT PRIMARY KEY, userId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, model TEXT NOT NULL, promptTokens INTEGER, completionTokens INTEGER, costUsd REAL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);`);
    // Per-Dot attribution was added later; migrate old databases in place.
    try {
      this.db.exec('ALTER TABLE usage ADD COLUMN dotId TEXT');
    } catch {
      // Column already present — nothing to do.
    }
    // Provider prompt-cache accounting (2026-10-16): cache-hit input tokens.
    try {
      this.db.exec('ALTER TABLE usage ADD COLUMN cachedTokens INTEGER');
    } catch {
      // Column already present — nothing to do.
    }
    // settings : singleton (id=1) -> une ligne par compte (userId).
    const settingsSql = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'",
      )
      .get() as { sql?: string } | undefined;
    if (settingsSql?.sql && !/userId/i.test(settingsSql.sql)) {
      this.db.exec(`BEGIN;
        CREATE TABLE settings_new(userId TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings_new SELECT NULL, value FROM settings;
        DROP TABLE settings;
        ALTER TABLE settings_new RENAME TO settings;
        COMMIT;`);
    }
    for (const table of ['tasks', 'runs', 'events', 'memories']) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === 'user_id')
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
    }
    // C3 : la consommation est attribuée au compte (via le Dot).
    if (
      !this.db
        .prepare('PRAGMA table_info(usage)')
        .all()
        .some((row) => row.name === 'user_id')
    )
      this.db.exec('ALTER TABLE usage ADD COLUMN user_id TEXT');
  }
  /** Nouvelle instance portée par cet utilisateur, même connexion DB. */
  forUser(userId: string): Store {
    return new Store(this.db, userId);
  }
  private requireUser(): string {
    if (this.userId === null)
      throw new Error('Store: no user bound (call forUser first).');
    return this.userId;
  }
  /** Migration (système) : réclame les lignes orphelines. Idempotente. */
  claimOrphans(userId: string) {
    for (const table of ['tasks', 'runs', 'events', 'memories'])
      this.db
        .prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`)
        .run(userId);
    this.db
      .prepare('UPDATE settings SET userId=? WHERE userId IS NULL')
      .run(userId);
    try {
      this.db
        .prepare(
          'UPDATE settings_quarantine SET user_id=? WHERE user_id IS NULL',
        )
        .run(userId);
    } catch {
      /* table absente : rien à réclamer */
    }
    // C3 : la consommation est réclamée via le Dot propriétaire (la table
    // dots vit dans le même fichier DB en prod ; absente en test isolé).
    try {
      this.db
        .prepare(
          'UPDATE usage SET user_id=(SELECT user_id FROM dots WHERE dots.id=usage.dotId) WHERE user_id IS NULL AND dotId IS NOT NULL',
        )
        .run();
    } catch {
      /* table dots absente : rien à réclamer */
    }
  }
  setupTelemetryState(): string | undefined {
    return (
      this.db.prepare('SELECT value FROM setup_telemetry WHERE id=1').get() as
        { value: string } | undefined
    )?.value;
  }
  saveSetupTelemetryState(value: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO setup_telemetry VALUES (1, ?)')
      .run(value);
  }
  clearSetupTelemetry() {
    this.db.prepare('DELETE FROM setup_telemetry').run();
  }
  close() {
    try {
      this.db.close();
    } catch {
      /* déjà fermé : close idempotent pour un shutdown sans erreur */
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Réglages du compte porté (graine paresseuse aux défauts) ; défauts si non porté. */
  settings(): Settings {
    if (this.userId === null) return { ...defaults };
    const row = this.db
      .prepare('SELECT value FROM settings WHERE userId=?')
      .get(this.userId) as { value: string } | undefined;
    if (!row) {
      this.db
        .prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)')
        .run(this.userId, JSON.stringify(defaults));
      return { ...defaults };
    }
    // Merge defaults so settings rows written before a field existed keep a
    // sane value for the new field.
    try {
      return { ...defaults, ...(JSON.parse(row.value) as Partial<Settings>) };
    } catch {
      // Ligne corrompue : mise de côté append-only (jamais supprimée) puis
      // réinitialisation de la ligne aux défauts, pour que l'avertissement ne
      // se répète pas à chaque boot. Restauration manuelle possible depuis
      // settings_quarantine (la plus récente en dernier).
      this.quarantineSettings(row.value, 'unreadable settings JSON');
      this.db
        .prepare('UPDATE settings SET value=? WHERE userId=?')
        .run(JSON.stringify(defaults), this.userId);
      console.warn(
        'Store: ligne settings illisible, défauts appliqués (original mis de côté dans settings_quarantine pour restauration manuelle).',
      );
      return { ...defaults };
    }
  }
  /** Lecture système : les réglages d'un compte (pour le runner). */
  private settingsForUser(userId: string): Settings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE userId=?')
      .get(userId) as { value: string } | undefined;
    if (!row) return { ...defaults };
    try {
      return { ...defaults, ...(JSON.parse(row.value) as Partial<Settings>) };
    } catch {
      return { ...defaults };
    }
  }
  /** Append-only quarantine: a second corruption never overwrites the first. */
  private quarantineSettings(value: string, reason: string) {
    try {
      const existing = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='settings_quarantine'",
        )
        .get() as { sql: string } | undefined;
      // Legacy single-row schema (id CHECK(id=1)): rename + copy so a
      // previously quarantined value is preserved, never dropped.
      if (existing && !/AUTOINCREMENT/i.test(existing.sql)) {
        this.db.exec(
          'ALTER TABLE settings_quarantine RENAME TO settings_quarantine_legacy',
        );
        this.db.exec(
          'CREATE TABLE settings_quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, quarantinedAt INTEGER NOT NULL, reason TEXT, user_id TEXT)',
        );
        try {
          this.db.exec(
            "INSERT INTO settings_quarantine(value, quarantinedAt, reason) SELECT value, quarantinedAt, 'legacy' FROM settings_quarantine_legacy",
          );
        } catch {
          /* copy best-effort */
        }
        this.db.exec('DROP TABLE settings_quarantine_legacy');
      }
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS settings_quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, quarantinedAt INTEGER NOT NULL, reason TEXT, user_id TEXT)',
      );
      this.db
        .prepare(
          'INSERT INTO settings_quarantine(value, quarantinedAt, reason, user_id) VALUES (?, ?, ?, ?)',
        )
        .run(value, Date.now(), reason, this.userId ?? null);
    } catch {
      /* mise de côté best-effort */
    }
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const userId = this.requireUser();
    return this.transaction(() => {
      const previous = this.settings();
      const settings = { ...previous, ...patch };
      this.db
        .prepare('UPDATE settings SET value=? WHERE userId=?')
        .run(JSON.stringify(settings), userId);
      if (
        (!previous.paused && settings.paused) ||
        (previous.researchAllowed && !settings.researchAllowed) ||
        (previous.memoryAllowed && !settings.memoryAllowed)
      ) {
        const running = this.tasks().filter((t) => t.status === 'running');
        for (const task of running) {
          this.invalidate(
            task,
            'interrupted',
            'Run interrupted because settings changed. Review completed effects before retrying.',
          );
        }
      }
      return settings;
    });
  }
  private mapTask(row: Record<string, unknown>): Task {
    const { user_id, ...rest } = row;
    return {
      ...(rest as unknown as Task),
      userId: typeof user_id === 'string' ? user_id : '',
    } as unknown as Task;
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY createdAt DESC')
      .all(this.userId)
      .map((row) =>
        this.mapTask(row as Record<string, unknown>),
      ) as unknown as Task[];
  }
  /** Liste système (runner) : toutes les tâches, tous comptes. */
  tasksAll(): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all()
      .map((row) =>
        this.mapTask(row as Record<string, unknown>),
      ) as unknown as Task[];
  }
  task(id: string): Task | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id=? AND user_id=?')
      .get(id, this.userId) as Record<string, unknown> | undefined;
    return row ? this.mapTask(row) : undefined;
  }
  createTask(
    prompt: string,
    intervalSeconds: number | null = null,
    runAt: number | null = null,
  ): Task {
    const userId = this.requireUser();
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, NULL, ?)",
      )
      .run(id, prompt, intervalSeconds, runAt, now, now, userId);
    this.event(
      id,
      null,
      runAt
        ? `Task scheduled for ${new Date(runAt).toISOString()}.`
        : 'Task added to the queue.',
    );
    return this.task(id)!;
  }
  detail(id: string): Detail | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE taskId=? AND user_id=? ORDER BY startedAt DESC, rowid DESC',
      )
      .all(id, this.userId) as unknown as (Omit<Run, 'result'> & {
      result: string | null;
    })[];
    return {
      task,
      runs: rows.map((row) => ({
        ...row,
        result: row.result
          ? safeJsonParse<Result>(row.result, null as never, 'runs.result')
          : null,
      })),
      events: this.db
        .prepare(
          'SELECT * FROM events WHERE taskId=? AND user_id=? ORDER BY id',
        )
        .all(id, this.userId) as unknown as TaskEvent[],
    };
  }
  /** Événement dans le périmètre du store porté. */
  event(taskId: string, runId: string | null, text: string) {
    const userId = this.requireUser();
    this.eventFor(taskId, runId, text, userId);
  }
  /** Événement système (runner) : l'utilisateur vient de la tâche. */
  private eventFor(
    taskId: string,
    runId: string | null,
    text: string,
    userId: string,
  ) {
    this.db
      .prepare(
        'INSERT INTO events (taskId, runId, text, createdAt, user_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, runId, text, Date.now(), userId);
  }
  private invalidate(task: Task, status: string, reason: string) {
    const now = Date.now();
    if (task.lease)
      this.db
        .prepare(
          "UPDATE runs SET status='interrupted', finishedAt=?, error=? WHERE id=? AND status='running' AND user_id=?",
        )
        .run(now, reason, task.lease, task.userId);
    this.db
      .prepare(
        'UPDATE tasks SET status=?, lease=NULL, leaseUntil=NULL, updatedAt=?, error=? WHERE id=? AND user_id=?',
      )
      .run(
        status,
        now,
        status === 'interrupted' ? reason : null,
        task.id,
        task.userId,
      );
    this.eventFor(task.id, task.lease, reason, task.userId);
  }
  action(id: string, action: Action): Task | undefined {
    return this.transaction(() => {
      const task = this.task(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return task;
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      this.invalidate(
        task,
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      this.db
        .prepare(
          'UPDATE tasks SET error=NULL, nextRunAt=NULL WHERE id=? AND user_id=?',
        )
        .run(id, task.userId);
      return this.task(id);
    });
  }
  schedule(id: string, intervalSeconds: number | null): Task | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const next =
      intervalSeconds && task.status === 'completed'
        ? Date.now() + intervalSeconds * 1000
        : null;
    this.db
      .prepare(
        'UPDATE tasks SET intervalSeconds=?, nextRunAt=?, updatedAt=? WHERE id=? AND user_id=?',
      )
      .run(intervalSeconds, next, Date.now(), id, task.userId);
    this.event(
      id,
      null,
      intervalSeconds
        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
        : 'Repeat schedule removed.',
    );
    return this.task(id);
  }
  /**
   * Réclame la prochaine tâche due. Système : sur un store non porté,
   * tous comptes (en respectant les réglages de chaque propriétaire) ;
   * sur un store porté, ce compte seulement.
   */
  claim(now = Date.now()): Claim | null {
    return this.transaction(() => {
      const user = this.userId ?? null;
      const expired = this.db
        .prepare(
          "SELECT * FROM tasks WHERE status='running' AND leaseUntil<=? AND (? IS NULL OR user_id=?)",
        )
        .all(now, user, user) as unknown as Task[];
      for (const task of expired)
        this.invalidate(
          this.mapTask(task as unknown as Record<string, unknown>),
          'interrupted',
          'Worker lease expired. Review completed effects before retrying.',
        );
      // Les tâches des comptes en pause / sans recherche sont sautées
      // (jamais réclamées), sans bloquer les autres comptes.
      // Parenthèses : le filtre compte s'applique aux deux branches
      // (queued OU completed), pas seulement à la seconde.
      const due = this.db
        .prepare(
          "SELECT * FROM tasks WHERE ((status='queued' AND (nextRunAt IS NULL OR nextRunAt<=?)) OR (status='completed' AND nextRunAt IS NOT NULL AND nextRunAt<=?)) AND (? IS NULL OR user_id=?) ORDER BY createdAt",
        )
        .all(now, now, user, user) as unknown as Task[];
      for (const raw of due) {
        const task = this.mapTask(raw as unknown as Record<string, unknown>);
        const ownerSettings = this.settingsForUser(task.userId);
        if (ownerSettings.paused || !ownerSettings.researchAllowed) continue;
        const lease = randomUUID();
        this.db
          .prepare(
            "UPDATE tasks SET status='running', lease=?, leaseUntil=?, nextRunAt=NULL, error=NULL, updatedAt=? WHERE id=? AND user_id=?",
          )
          .run(lease, now + 180_000, now, task.id, task.userId);
        this.db
          .prepare(
            "INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL, NULL, ?)",
          )
          .run(lease, task.id, now, task.userId);
        this.eventFor(task.id, lease, 'Run started.', task.userId);
        const updated = this.db
          .prepare('SELECT * FROM tasks WHERE id=?')
          .get(task.id) as Record<string, unknown>;
        return { ...this.mapTask(updated), lease };
      }
      return null;
    });
  }
  owns(claim: Claim): boolean {
    const task = this.task(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  finish(claim: Claim, result: Result, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(claim)) return false;
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='completed', finishedAt=?, result=? WHERE id=? AND user_id=?",
        )
        .run(now, JSON.stringify(result), claim.lease, task.userId);
      this.db
        .prepare(
          "UPDATE tasks SET status='completed', lease=NULL, leaseUntil=NULL, updatedAt=?, nextRunAt=? WHERE id=? AND user_id=?",
        )
        .run(
          now,
          task.intervalSeconds ? now + task.intervalSeconds * 1000 : null,
          claim.id,
          task.userId,
        );
      this.event(
        claim.id,
        claim.lease,
        result.sample ? 'Fictional sample brief ready.' : 'Run completed.',
      );
      return true;
    });
  }
  interrupt(claim: Claim, reason: string) {
    this.transaction(() => {
      if (this.owns(claim)) this.invalidate(claim, 'interrupted', reason);
    });
  }
  fail(claim: Claim, error: string) {
    this.transaction(() => {
      if (!this.owns(claim)) return;
      const now = Date.now();
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='failed', finishedAt=?, error=? WHERE id=? AND user_id=?",
        )
        .run(now, error, claim.lease, task.userId);
      this.db
        .prepare(
          "UPDATE tasks SET status='failed', lease=NULL, leaseUntil=NULL, error=?, updatedAt=? WHERE id=? AND user_id=?",
        )
        .run(error, now, claim.id, task.userId);
      this.event(claim.id, claim.lease, error);
    });
  }
  memories(): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE user_id=? ORDER BY createdAt DESC')
      .all(this.userId)
      .map((row) => {
        const { user_id, ...rest } = row as Record<string, unknown>;
        return {
          ...(rest as unknown as Memory),
          userId: typeof user_id === 'string' ? user_id : '',
        };
      }) as unknown as Memory[];
  }
  saveMemory(text: string, id: string = randomUUID()): Memory {
    const userId = this.requireUser();
    // Un id existant chez un AUTRE compte ne doit jamais être écrasé :
    // l'upsert ci-dessous ne touche que la ligne de ce compte.
    const existing = this.db
      .prepare('SELECT user_id FROM memories WHERE id=?')
      .get(id) as { user_id?: string } | undefined;
    if (existing && existing.user_id !== userId)
      throw new Error('Memory not found.');
    this.db
      .prepare(
        'INSERT INTO memories VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text',
      )
      .run(id, text, Date.now(), userId);
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id=? AND user_id=?')
      .get(id, userId) as Record<string, unknown> | undefined;
    const { user_id, ...rest } = row ?? {};
    return {
      ...(rest as unknown as Memory),
      userId: typeof user_id === 'string' ? user_id : userId,
    } as unknown as Memory;
  }
  deleteMemory(id: string): boolean {
    this.requireUser();
    return (
      this.db
        .prepare('DELETE FROM memories WHERE id=? AND user_id=?')
        .run(id, this.userId).changes > 0
    );
  }
  deleteAllMemories(): number {
    this.requireUser();
    return this.db
      .prepare('DELETE FROM memories WHERE user_id=?')
      .run(this.userId).changes as number;
  }
  /**
   * C2 — pièces jointes (fichiers disque) : la table `attachment_users`
   * relie chaque pièce jointe à son compte. Les routes vérifient la
   * propriété via `attachmentOwner` (porté : ne renvoie que si c'est
   * à ce compte) ; `claimAttachment` (système) attribue une pièce
   * jointe sans propriétaire, sans jamais voler celle d'un autre compte
   * (garde NOT EXISTS).
   */
  attachmentOwner(attachmentId: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT userId FROM attachment_users WHERE attachmentId=? AND userId=?',
      )
      .get(attachmentId, this.userId) as { userId?: string } | undefined;
    return typeof row?.userId === 'string' ? row.userId : undefined;
  }
  /** Système : le propriétaire, quel que soit le compte (pour le claim). */
  attachmentOwnerAny(attachmentId: string): string | undefined {
    const row = this.db
      .prepare('SELECT userId FROM attachment_users WHERE attachmentId=?')
      .get(attachmentId) as { userId?: string } | undefined;
    return typeof row?.userId === 'string' ? row.userId : undefined;
  }
  claimAttachment(attachmentId: string, userId: string): void {
    this.db
      .prepare(
        'INSERT INTO attachment_users (attachmentId, userId) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM attachment_users WHERE attachmentId=?)',
      )
      .run(attachmentId, userId, attachmentId);
  }
  deleteAttachmentOwner(attachmentId: string): boolean {
    this.requireUser();
    return (
      this.db
        .prepare(
          'DELETE FROM attachment_users WHERE attachmentId=? AND userId=?',
        )
        .run(attachmentId, this.userId).changes > 0
    );
  }
  /** Phase E (suppression de compte) : les pièces jointes du compte. */
  attachmentIdsForUser(userId: string): string[] {
    return (
      this.db
        .prepare('SELECT attachmentId FROM attachment_users WHERE userId=?')
        .all(userId) as Array<{ attachmentId: string }>
    ).map((row) => row.attachmentId);
  }
  /**
   * Phase E (suppression de compte) : efface les données du Store d'un
   * compte (opération système, prend le userId en paramètre). Les
   * fichiers des pièces jointes sont effacés par
   * Platform.deleteUserData (via attachmentIdsForUser, AVANT cet appel).
   */
  deleteUserData(userId: string) {
    this.db.prepare('DELETE FROM settings WHERE userId=?').run(userId);
    // attachment_users utilise userId (pas user_id).
    this.db.prepare('DELETE FROM attachment_users WHERE userId=?').run(userId);
    for (const table of ['tasks', 'runs', 'events', 'memories', 'usage'])
      this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    // settings_quarantine n'existe que si une valeur a été mise de côté.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings_quarantine'",
        )
        .get()
    )
      this.db
        .prepare('DELETE FROM settings_quarantine WHERE user_id=?')
        .run(userId);
  }
  /** Record one model completion's token usage (best-effort, no throw). */
  recordUsage(entry: {
    ts: number;
    dotId: string | null;
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens?: number | null;
    costUsd: number | null;
  }): void {
    // C3 : la consommation est attribuée au compte porté par ce store
    // (le DotAgent écrit via le store porté du Dot). Best-effort : un
    // store non lié écrit un orphelin (NULL), réclamé via le Dot au boot.
    this.db
      .prepare(
        'INSERT INTO usage (ts, dotId, model, promptTokens, completionTokens, cachedTokens, costUsd, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.ts,
        entry.dotId,
        entry.model,
        entry.promptTokens,
        entry.completionTokens,
        entry.cachedTokens ?? null,
        entry.costUsd,
        this.userId,
      );
  }
  /** Phase E : coût du mois calendaire en cours (UTC) pour ce compte. */
  monthCostUsd(now = Date.now()): number {
    const start = new Date(now);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(costUsd), 0) AS cost FROM usage WHERE ts >= ? AND user_id=?',
      )
      .get(start.getTime(), this.userId) as { cost: number };
    return row.cost;
  }
  /** Totals for two windows: the current calendar day and the last 7 days. */
  usageSummary(now = Date.now()): UsageReport {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    const aggregate = (since: number): UsageSummary => {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS runs,
                  COALESCE(SUM(promptTokens), 0) AS promptTokens,
                  COALESCE(SUM(cachedTokens), 0) AS cachedTokens,
                  COALESCE(SUM(completionTokens), 0) AS completionTokens,
                  COALESCE(SUM(costUsd), 0) AS costUsd
             FROM usage WHERE ts >= ? AND user_id=?`,
        )
        .get(since, this.userId) as {
        runs: number;
        promptTokens: number;
        cachedTokens: number;
        completionTokens: number;
        costUsd: number;
      };
      return {
        runs: row.runs,
        promptTokens: row.promptTokens,
        cachedTokens: row.cachedTokens,
        completionTokens: row.completionTokens,
        costUsd: row.costUsd,
      };
    };
    const byDot = this.db
      .prepare(
        `SELECT dotId,
                COUNT(*) AS runs,
                COALESCE(SUM(promptTokens), 0) AS promptTokens,
                COALESCE(SUM(cachedTokens), 0) AS cachedTokens,
                COALESCE(SUM(completionTokens), 0) AS completionTokens,
                COALESCE(SUM(costUsd), 0) AS costUsd
           FROM usage WHERE ts >= ? AND dotId IS NOT NULL AND user_id=?
          GROUP BY dotId ORDER BY costUsd DESC`,
      )
      .all(weekStart, this.userId) as unknown as DotUsage[];
    return {
      today: aggregate(startOfDay.getTime()),
      week: aggregate(weekStart),
      byDot,
    };
  }
}
