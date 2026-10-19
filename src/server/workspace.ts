import { ComputerStore } from './computer-store.js';
import { ConnectionStore } from './connection-store.js';
import { Pages } from './pages.js';
import { resolveLegacySecretKey, resolveSecretKey } from './secrets.js';
import { safeJsonParse } from './safe-json.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AVATAR_IDS } from '../shared/avatars.js';
import { validateLearningSettings } from '../shared/learning.js';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';

/**
 * WorkspaceStore — Phase C1 : isolation par compte.
 *
 * Le store est CONSTRUIT SANS utilisateur (userId = undefined) puis
 * PORTÉ par `forUser(userId)` : chaque requête / agent / tâche travaille
 * avec une instance portée, et TOUTES les lectures/écritures sont filtrées
 * par userId en SQL.
 *
 * Règle fail-closed : un store NON porté ne voit RIEN (les requêtes
 * filtrent sur `user_id = NULL`, qui ne matche aucune ligne) et ses
 * écritures lèvent. Seules les méthodes explicitement « système »
 * (ownerOf*, *All, claimOrphans) lisent sans filtre — elles ne renvoient
 * jamais de données utilisateur, seulement des ids/propriétaires, et ne
 * servent qu'à établir la portée (agent, runner, voix) ou à la migration.
 *
 * Tables : thread_bindings réutilise sa colonne ownerId existante (c'est
 * déjà le userId) ; les autres tables ont une colonne user_id ajoutée par
 * migration (NULL = ligne orpheline du monde mono-utilisateur, réclamée
 * par claimOrphans au boot / au bootstrap).
 */
/** Phase E : limites / droits d'un compte (retournés par le callback
 *  `getUserRecord`, branché dans index.ts sur l'AuthStore). */
export interface UserLimits {
  role: string;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  monthlyLimitUsd: number | null;
  maxDots: number | null;
}
export interface WorkspaceStoreOptions {
  /** Résout la fiche compte d'un userId (AuthStore). Absent en test. */
  getUserRecord?: (userId: string) => UserLimits | undefined;
}
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  constructor(
    pathOrDb: string | DatabaseSync,
    readonly userId: string | null = null,
    private readonly options: WorkspaceStoreOptions = {},
  ) {
    if (typeof pathOrDb === 'string') {
      if (pathOrDb !== ':memory:')
        mkdirSync(dirname(pathOrDb), { recursive: true });
      this.db = new DatabaseSync(pathOrDb);
    } else {
      this.db = pathOrDb;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT, user_id TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS thread_activity(threadId TEXT PRIMARY KEY, value TEXT NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS app_config(user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id, key));`);
    for (const [table, column, definition] of [
      ['spaces', 'user_id', 'TEXT'],
      ['dots', 'user_id', 'TEXT'],
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'provider', 'TEXT'],
      ['dots', 'model', 'TEXT'],
      ['dots', 'reasoningEffort', 'TEXT'],
      ['dots', 'avatar', 'TEXT'],
      ['dots', 'contextBudget', 'INTEGER'],
      ['dots', 'compactionStrategy', 'TEXT'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      ['thread_bindings', 'updatedAt', 'INTEGER'],
      ['thread_bindings', 'summary', 'TEXT'],
      ['thread_bindings', 'isMaster', 'INTEGER NOT NULL DEFAULT 0'],
      ['task_threads', 'user_id', 'TEXT'],
      ['calls', 'user_id', 'TEXT'],
      ['captures', 'user_id', 'TEXT'],
      ['thread_activity', 'user_id', 'TEXT'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // app_config passe de (key) à (user_id, key) : reconstruction par
    // copie, les lignes existantes deviennent orphelines (user_id NULL).
    if (
      !this.db
        .prepare('PRAGMA table_info(app_config)')
        .all()
        .some((field) => field.name === 'user_id')
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE app_config_new(user_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id, key));
        INSERT INTO app_config_new SELECT NULL, key, value FROM app_config;
        DROP TABLE app_config;
        ALTER TABLE app_config_new RENAME TO app_config;
        COMMIT;`);
    }
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    if (
      !this.db
        .prepare('PRAGMA table_info(dot_spaces)')
        .all()
        .some((field) => field.name === 'user_id')
    )
      this.db.exec('ALTER TABLE dot_spaces ADD COLUMN user_id TEXT');
    this.computers = new ComputerStore(this.db, userId);
    this.connections = new ConnectionStore(
      this.db,
      () => resolveSecretKey(),
      () => resolveLegacySecretKey(),
      userId,
    );
    this.pages = new Pages(
      this.db,
      (id) => this.spaces().some((space) => space.id === id),
      userId,
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
  }
  /** Nouvelle instance portée par cet utilisateur, même connexion DB. */
  forUser(userId: string): WorkspaceStore {
    return new WorkspaceStore(this.db, userId, this.options);
  }
  /**
   * Phase E : limites / droits du compte lié (via le callback AuthStore).
   * undefined = sans restriction (pas de callback en test, compte
   * introuvable, ou Admin — un Admin n'est jamais restreint).
   */
  userLimits(): UserLimits | undefined {
    if (this.userId === null || !this.options.getUserRecord) return undefined;
    const record = this.options.getUserRecord(this.userId);
    if (!record || record.role === 'admin') return undefined;
    return record;
  }
  /** Écriture sans utilisateur = erreur (jamais de ligne orpheline neuve). */
  private requireUser(): string {
    if (this.userId === null)
      throw new Error('WorkspaceStore: no user bound (call forUser first).');
    return this.userId;
  }
  /**
   * Migration (système) : réclame les lignes orphelines (user_id NULL, ou
   * ownerId hors users pour thread_bindings) au premier compte. Appelée au
   * boot et au bootstrap (premier Admin). Idempotente.
   */
  claimOrphans(userId: string) {
    for (const table of [
      'spaces',
      'dots',
      'dot_spaces',
      'task_threads',
      'calls',
      'captures',
      'thread_activity',
    ])
      this.db
        .prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`)
        .run(userId);
    this.db
      .prepare('UPDATE app_config SET user_id=? WHERE user_id IS NULL')
      .run(userId);
    const usersTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'",
      )
      .get();
    if (usersTable)
      this.db
        .prepare(
          'UPDATE thread_bindings SET ownerId=? WHERE ownerId NOT IN (SELECT id FROM users)',
        )
        .run(userId);
    // Phase D : le compte réclamant hérite d'une maître = sa plus ancienne
    // conversation (sa 1ère requête). Si une maître existe déjà, rien.
    const hasMaster = this.db
      .prepare('SELECT 1 FROM thread_bindings WHERE ownerId=? AND isMaster=1')
      .get(userId);
    if (!hasMaster)
      this.db
        .prepare(
          `UPDATE thread_bindings SET isMaster=1 WHERE id=(
            SELECT id FROM thread_bindings
            WHERE ownerId=? AND isMaster=0 ORDER BY createdAt ASC LIMIT 1
          )`,
        )
        .run(userId);
    this.pages.claimOrphans(userId);
    this.connections.claimOrphans(userId);
    // C2 : les messages du runner (même fichier DB) et les permissions /
    // le journal des ordinateurs (résolus via le Dot propriétaire).
    // Les tables runner_* n'existent que si le runner a déjà tourné.
    for (const table of ['runner_threads', 'runner_runs']) {
      const exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (exists)
        this.db
          .prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`)
          .run(userId);
    }
    this.computers.claimOrphans();
  }
  /**
   * Phase E (suppression de compte) : efface TOUTES les données du monde
   * d'un compte (opération système, prend le userId en paramètre). Les
   * tables du Store (tâches, mémoires, usage, …) sont effacées par
   * Store.deleteUserData, les threads du runner par
   * SqliteAgentRunner.deleteUserThreads — le tout orchestré par
   * Platform.deleteUserData.
   */
  deleteUserData(userId: string) {
    // Les ordinateurs D'ABORD (avant la boucle qui efface les Dots) :
    // leur suppression se résout via les Dots (dots.user_id) — si les
    // Dots sont effacés avant, rien n'est trouvé et les lignes
    // computer_permissions / computer_audit survivent en orphelines.
    this.computers.deleteUserData(userId);
    for (const table of [
      'spaces',
      'dots',
      'dot_spaces',
      'task_threads',
      'calls',
      'captures',
      'thread_activity',
      'app_config',
    ])
      this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    this.db.prepare('DELETE FROM thread_bindings WHERE ownerId=?').run(userId);
    this.pages.deleteUserData(userId);
    this.connections.deleteUserData(userId);
  }
  /**
   * Résolutions « système » (jamais de données utilisateur) : servent à
   * établir la portée d'un agent / d'une tâche / d'un appel avant tout
   * accès filtré.
   */
  ownerOfDot(dotId: string): string | undefined {
    const row = this.db
      .prepare('SELECT user_id FROM dots WHERE id=?')
      .get(dotId) as { user_id?: string } | undefined;
    return typeof row?.user_id === 'string' ? row.user_id : undefined;
  }
  ownerOfThread(threadId: string): string | undefined {
    const row = this.db
      .prepare('SELECT ownerId FROM thread_bindings WHERE id=?')
      .get(threadId) as { ownerId?: string } | undefined;
    return typeof row?.ownerId === 'string' ? row.ownerId : undefined;
  }
  ownerOfSpace(spaceId: string): string | undefined {
    const row = this.db
      .prepare('SELECT user_id FROM spaces WHERE id=?')
      .get(spaceId) as { user_id?: string } | undefined;
    return typeof row?.user_id === 'string' ? row.user_id : undefined;
  }
  ownerOfCall(callId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM calls WHERE id=?')
      .get(callId) as { threadId?: string } | undefined;
    return row?.threadId ? this.ownerOfThread(row.threadId) : undefined;
  }
  /** Liste système (agents factory) : tous les Dots, tous comptes. */
  dotsAll(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => this.mapDot(row)) as unknown as Dot[];
  }
  /** Liste système (reprise voix) : tous les appels, tous comptes. */
  callsAll(): CallReceipt[] {
    return this.db
      .prepare('SELECT * FROM calls ORDER BY startedAt DESC')
      .all() as unknown as CallReceipt[];
  }
  /**
   * Graine par compte : le premier accès d'un utilisateur sans Space crée
   * son Space « Everyday » + son Dot. Appelée par la route workspace (et
   * par les fixtures de test), jamais au constructeur.
   */
  ensureSeed() {
    this.requireUser();
    if (this.spaces().length) return;
    const space = this.createSpace('Everyday', 'A little space for your day.');
    this.createDot(
      space.id,
      'Dot',
      'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
      true,
      true,
    );
  }
  close() {
    try {
      this.db.close();
    } catch {
      /* déjà fermé : close idempotent pour un shutdown sans erreur */
    }
  }
  configGet(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM app_config WHERE key=? AND user_id=?')
      .get(key, this.userId) as { value: string } | undefined;
    return row?.value;
  }
  configSet(key: string, value: string) {
    const userId = this.requireUser();
    this.db
      .prepare(
        'INSERT INTO app_config(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value',
      )
      .run(userId, key, value);
  }
  configDelete(key: string) {
    const userId = this.requireUser();
    this.db
      .prepare('DELETE FROM app_config WHERE key=? AND user_id=?')
      .run(key, userId);
  }
  configList(prefix: string): { key: string; value: string }[] {
    return this.db
      .prepare(
        'SELECT key, value FROM app_config WHERE key LIKE ? AND user_id=? ORDER BY key',
      )
      .all(`${prefix}%`, this.userId) as unknown as {
      key: string;
      value: string;
    }[];
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces WHERE user_id=? ORDER BY createdAt')
      .all(this.userId) as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const userId = this.requireUser();
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt, userId);
    return space;
  }
  space(id: string): Space | undefined {
    return this.spaces().find((space) => space.id === id);
  }
  updateSpace(id: string, name: string, description: string): Space {
    this.requireUser();
    if (!this.space(id)) throw new Error('Space not found.');
    this.db
      .prepare(
        'UPDATE spaces SET name=?, description=? WHERE id=? AND user_id=?',
      )
      .run(name, description, id, this.userId);
    return this.space(id)!;
  }
  private mapDot(row: Record<string, unknown>): Dot {
    const { user_id, ...rest } = row;
    return {
      ...(rest as unknown as Dot),
      userId: typeof user_id === 'string' ? user_id : '',
      spaceIds: this.db
        .prepare(
          'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
        )
        .all(String(row.id))
        .map((grant) => String(grant.spaceId)),
      researchAllowed: !!row.researchAllowed,
      memoryAllowed: !!row.memoryAllowed,
      skillDeliveryEnabled: !!row.skillDeliveryEnabled,
      provider: row.provider == null ? null : String(row.provider),
      model: row.model == null ? null : String(row.model),
      reasoningEffort:
        row.reasoningEffort == null ? null : String(row.reasoningEffort),
      avatar: row.avatar == null ? null : String(row.avatar),
    } as unknown as Dot;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots WHERE user_id=? ORDER BY createdAt')
      .all(this.userId)
      .map((row) =>
        this.mapDot(row as Record<string, unknown>),
      ) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  setDotModel(id: string, provider: string | null, model: string | null): Dot {
    this.requireUser();
    if (!this.dot(id)) throw new Error('Dot not found.');
    // Phase E : provider / modèle autorisés pour ce compte.
    const limits = this.userLimits();
    if (
      limits?.allowedProviders &&
      provider != null &&
      !limits.allowedProviders.includes(provider)
    )
      throw new Error(
        `Provider "${provider}" is not allowed for this account.`,
      );
    if (
      limits?.allowedModels &&
      model != null &&
      !limits.allowedModels.includes(model)
    )
      throw new Error(`Model "${model}" is not allowed for this account.`);
    this.db
      .prepare('UPDATE dots SET provider=?, model=? WHERE id=? AND user_id=?')
      .run(provider, model, id, this.userId);
    return this.dot(id)!;
  }
  setDotReasoning(id: string, effort: string | null): Dot {
    this.requireUser();
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET reasoningEffort=? WHERE id=? AND user_id=?')
      .run(effort, id, this.userId);
    return this.dot(id)!;
  }
  /** Phase 6 : budget de contexte par Dot (null = Max/agentique). */
  setDotContextBudget(id: string, budget: number | null): Dot {
    this.requireUser();
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET contextBudget=? WHERE id=? AND user_id=?')
      .run(budget, id, this.userId);
    return this.dot(id)!;
  }
  /** Phase 9 : stratégie de compaction par Dot (null = native). */
  setDotCompactionStrategy(
    id: string,
    strategy: 'native' | 'magic-compact' | null,
  ): Dot {
    this.requireUser();
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET compactionStrategy=? WHERE id=? AND user_id=?')
      .run(strategy, id, this.userId);
    return this.dot(id)!;
  }
  setDotAvatar(id: string, avatar: string | null): Dot {
    this.requireUser();
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET avatar=? WHERE id=? AND user_id=?')
      .run(avatar, id, this.userId);
    return this.dot(id)!;
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
    model: string | null = null,
    avatar: string | null = null,
  ): Dot {
    const userId = this.requireUser();
    // Phase E : nombre max de Dots + modèle autorisé pour ce compte.
    const limits = this.userLimits();
    if (limits?.maxDots != null && this.dots().length >= limits.maxDots)
      throw new Error('Dot limit reached.');
    if (
      limits?.allowedModels &&
      model != null &&
      !limits.allowedModels.includes(model)
    )
      throw new Error(`Model "${model}" is not allowed for this account.`);
    // Un id d'avatar n'est jamais un modèle : attrape une inversion
    // d'arguments (avatar passé dans le slot model) au lieu d'écrire
    // silencieusement une valeur corrompue.
    if (model !== null && (AVATAR_IDS as readonly string[]).includes(model))
      throw new Error(
        `Invalid model: "${model}" is an avatar id, not a model.`,
      );
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      userId,
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      learningContainerId,
      skillDeliveryEnabled,
      model,
      avatar,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, user_id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, model, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          userId,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
          model,
          avatar,
        );
      for (const id of dot.spaceIds)
        this.db
          .prepare('INSERT INTO dot_spaces VALUES (?, ?, ?)')
          .run(dot.id, id, userId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  /** Clone a Dot (instructions, permissions, spaces, model, avatar, tune). */
  duplicateDot(id: string): Dot | null {
    const current = this.dot(id);
    if (!current) return null;
    const copy = this.createDot(
      current.spaceId,
      `${current.name} (copie)`.slice(0, 40),
      current.instructions,
      current.researchAllowed,
      current.memoryAllowed,
      current.spaceIds,
      current.learningContainerId ?? null,
      current.skillDeliveryEnabled ?? false,
      current.model ?? null,
      current.avatar ?? null,
    );
    if (current.contextBudget != null)
      this.setDotContextBudget(copy.id, current.contextBudget);
    if (current.compactionStrategy != null)
      this.setDotCompactionStrategy(copy.id, current.compactionStrategy);
    return this.dot(copy.id) ?? null;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare(
        'SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=? AND user_id=?',
      )
      .get(dotId, spaceId, this.userId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
      avatar?: string | null;
    },
  ): Dot {
    this.requireUser();
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=? WHERE id=? AND user_id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          id,
          this.userId,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=? AND user_id=?')
        .run(defaultSpace, id, this.userId);
      this.db
        .prepare('DELETE FROM dot_spaces WHERE dotId=? AND user_id=?')
        .run(id, this.userId);
      for (const space of new Set(spaceIds))
        this.db
          .prepare('INSERT INTO dot_spaces VALUES (?, ?, ?)')
          .run(id, space, this.userId);
      if (patch.avatar !== undefined)
        this.db
          .prepare('UPDATE dots SET avatar=? WHERE id=? AND user_id=?')
          .run(patch.avatar, id, this.userId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  conversations(): Conversation[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
        )
        .all(this.userId) as Array<Record<string, unknown>>
    ).map((row) => ({
      ...(row as unknown as Conversation),
      isMaster: !!row.isMaster,
    }));
  }
  bindThread(
    id: string,
    dotId: string,
    title: string,
    opts: { master?: boolean } = {},
  ): Conversation {
    const userId = this.requireUser();
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    // Phase D : la première conversation du compte est la maître ; si la
    // maître a été fermée, la prochaine conversation créée devient la
    // nouvelle maître. Les conversations de page ne deviennent jamais maître.
    const hasMaster = this.db
      .prepare('SELECT 1 FROM thread_bindings WHERE ownerId=? AND isMaster=1')
      .get(userId);
    const isMaster = opts.master !== false && !hasMaster;
    const value: Conversation = {
      id,
      dotId,
      ownerId: userId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
      isMaster,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, isMaster) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        userId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
        isMaster ? 1 : 0,
      );
    return value;
  }
  /** Records the outcome + activity of a finished turn for the activity timeline. */
  recordThreadActivity(
    id: string,
    input: { summary: string | null; activity: unknown },
  ): Conversation {
    this.requireUser();
    const thread = this.requireThread(id);
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE thread_bindings SET updatedAt=?, summary=? WHERE id=? AND ownerId=?',
      )
      .run(now, input.summary, id, this.userId);
    this.db
      .prepare('INSERT OR REPLACE INTO thread_activity VALUES (?, ?, ?)')
      .run(id, JSON.stringify(input.activity ?? []), this.userId);
    return { ...thread, updatedAt: now, summary: input.summary };
  }
  threadActivity(id: string): unknown {
    this.requireThread(id);
    const row = this.db
      .prepare(
        'SELECT value FROM thread_activity WHERE threadId=? AND user_id=?',
      )
      .get(id, this.userId) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  deleteThread(id: string): boolean {
    this.requireUser();
    const exists = this.conversations().some((thread) => thread.id === id);
    if (!exists) return false;
    this.db
      .prepare('DELETE FROM thread_bindings WHERE id=? AND ownerId=?')
      .run(id, this.userId);
    this.db
      .prepare('DELETE FROM task_threads WHERE threadId=? AND user_id=?')
      .run(id, this.userId);
    this.db
      .prepare('DELETE FROM calls WHERE threadId=? AND user_id=?')
      .run(id, this.userId);
    this.db
      .prepare('DELETE FROM captures WHERE threadId=? AND user_id=?')
      .run(id, this.userId);
    this.db
      .prepare('DELETE FROM thread_activity WHERE threadId=? AND user_id=?')
      .run(id, this.userId);
    return true;
  }
  deleteAllThreads(): number {
    const ids = this.conversations().map((thread) => thread.id);
    for (const id of ids) this.deleteThread(id);
    return ids.length;
  }
  bindTask(taskId: string, threadId: string) {
    const userId = this.requireUser();
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?, ?)')
      .run(taskId, threadId, userId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=? AND user_id=?')
      .get(taskId, this.userId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls WHERE user_id=? ${threadId ? 'AND threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(
        ...(threadId ? [this.userId, threadId] : [this.userId]),
      ) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    const userId = this.requireUser();
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error, user_id) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '', userId);
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    this.requireUser();
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=? AND user_id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
        this.userId,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.requireUser();
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND user_id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id, this.userId).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.requireUser();
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=? AND user_id=?')
      .run(anchor ?? null, id, this.userId);
  }
  setCallError(id: string, error: string | null) {
    this.requireUser();
    this.call(id);
    this.db
      .prepare('UPDATE calls SET error=? WHERE id=? AND user_id=?')
      .run(error, id, this.userId);
  }
  saveCapture(threadId: string, value: unknown) {
    const userId = this.requireUser();
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value), userId);
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=? AND user_id=?')
      .get(threadId, this.userId);
    return typeof row?.value === 'string'
      ? safeJsonParse<unknown>(row.value, null, 'captures.value')
      : null;
  }
}
