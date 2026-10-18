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
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_activity(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
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
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    this.computers = new ComputerStore(this.db);
    this.connections = new ConnectionStore(
      this.db,
      () => resolveSecretKey(),
      () => resolveLegacySecretKey(),
    );
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
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
      .prepare('SELECT value FROM app_config WHERE key=?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }
  configSet(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO app_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  configDelete(key: string) {
    this.db.prepare('DELETE FROM app_config WHERE key=?').run(key);
  }
  configList(prefix: string): { key: string; value: string }[] {
    return this.db
      .prepare(
        'SELECT key, value FROM app_config WHERE key LIKE ? ORDER BY key',
      )
      .all(`${prefix}%`) as unknown as { key: string; value: string }[];
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  space(id: string): Space | undefined {
    return this.spaces().find((space) => space.id === id);
  }
  updateSpace(id: string, name: string, description: string): Space {
    if (!this.space(id)) throw new Error('Space not found.');
    this.db
      .prepare('UPDATE spaces SET name=?, description=? WHERE id=?')
      .run(name, description, id);
    return this.space(id)!;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
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
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  setDotModel(id: string, provider: string | null, model: string | null): Dot {
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET provider=?, model=? WHERE id=?')
      .run(provider, model, id);
    return this.dot(id)!;
  }
  setDotReasoning(id: string, effort: string | null): Dot {
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET reasoningEffort=? WHERE id=?')
      .run(effort, id);
    return this.dot(id)!;
  }
  /** Phase 6 : budget de contexte par Dot (null = Max/agentique). */
  setDotContextBudget(id: string, budget: number | null): Dot {
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET contextBudget=? WHERE id=?')
      .run(budget, id);
    return this.dot(id)!;
  }
  /** Phase 9 : stratégie de compaction par Dot (null = native). */
  setDotCompactionStrategy(
    id: string,
    strategy: 'native' | 'magic-compact' | null,
  ): Dot {
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db
      .prepare('UPDATE dots SET compactionStrategy=? WHERE id=?')
      .run(strategy, id);
    return this.dot(id)!;
  }
  setDotAvatar(id: string, avatar: string | null): Dot {
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db.prepare('UPDATE dots SET avatar=? WHERE id=?').run(avatar, id);
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
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, model, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
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
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
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
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
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
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      if (patch.avatar !== undefined)
        this.db
          .prepare('UPDATE dots SET avatar=? WHERE id=?')
          .run(patch.avatar, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
      );
    return value;
  }
  /** Records the outcome + activity of a finished turn for the activity timeline. */
  recordThreadActivity(
    id: string,
    input: { summary: string | null; activity: unknown },
  ): Conversation {
    const thread = this.requireThread(id);
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE thread_bindings SET updatedAt=?, summary=? WHERE id=? AND ownerId=?',
      )
      .run(now, input.summary, id, this.ownerId);
    this.db
      .prepare('INSERT OR REPLACE INTO thread_activity VALUES (?, ?)')
      .run(id, JSON.stringify(input.activity ?? []));
    return { ...thread, updatedAt: now, summary: input.summary };
  }
  threadActivity(id: string): unknown {
    this.requireThread(id);
    const row = this.db
      .prepare('SELECT value FROM thread_activity WHERE threadId=?')
      .get(id) as { value?: string } | undefined;
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
    const exists = this.conversations().some((thread) => thread.id === id);
    if (!exists) return false;
    this.db
      .prepare('DELETE FROM thread_bindings WHERE id=? AND ownerId=?')
      .run(id, this.ownerId);
    this.db.prepare('DELETE FROM task_threads WHERE threadId=?').run(id);
    this.db.prepare('DELETE FROM calls WHERE threadId=?').run(id);
    this.db.prepare('DELETE FROM captures WHERE threadId=?').run(id);
    this.db.prepare('DELETE FROM thread_activity WHERE threadId=?').run(id);
    return true;
  }
  deleteAllThreads(): number {
    const ids = this.conversations().map((thread) => thread.id);
    for (const id of ids) this.deleteThread(id);
    return ids.length;
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
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
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
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
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string'
      ? safeJsonParse<unknown>(row.value, null, 'captures.value')
      : null;
  }
}
