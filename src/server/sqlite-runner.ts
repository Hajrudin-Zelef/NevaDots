import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  InMemoryAgentRunner,
  ɵGLOBAL_STORE,
  type AgentRunnerRunRequest,
} from '@copilotkit/runtime/v2';

/** A completed run as the internal store keeps it (events already compacted). */
interface PersistedRun {
  runId: string;
  agentId: string | null;
  parentRunId: string | null;
  events: unknown[];
  messages: unknown[];
  createdAt: number;
}

interface GlobalThreadStore {
  getOrCreate(threadId: string): unknown;
  peek(
    threadId: string,
  ): { historicRuns: PersistedRun[]; messagesSnapshot: unknown[] } | undefined;
  appendRun(threadId: string, run: PersistedRun): void;
}

const globalStore = ɵGLOBAL_STORE as unknown as GlobalThreadStore;

/**
 * Durable AgentRunner: it reuses CopilotKit's in-memory run/connect machinery
 * (single `ɵGLOBAL_STORE`) but mirrors every completed run to SQLite and
 * rehydrates that store on construction, so transcripts survive restarts —
 * with no external service. Used by `Platform` in SSE mode (no Intelligence).
 */
export class SqliteAgentRunner extends InMemoryAgentRunner {
  private readonly db: DatabaseSync;

  constructor(path?: string) {
    super();
    const file = path || ':memory:';
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Même régime que les autres stores : WAL + busy_timeout, sinon
    // « database is locked » dès que le runner et l'UI écrivent ensemble.
    if (file !== ':memory:')
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runner_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        parent_run_id TEXT,
        events TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_threads (
        thread_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.rehydrate();
  }

  /** Ferme la connexion SQLite (shutdown). Idempotent : double close = no-op. */
  close() {
    try {
      this.db.close();
    } catch {
      /* déjà fermé */
    }
  }

  private rehydrate() {
    let skipped = 0;
    const threads = this.db
      .prepare(
        'SELECT thread_id, messages FROM runner_threads ORDER BY created_at',
      )
      .all() as Array<Record<string, unknown>>;
    for (const thread of threads) {
      const threadId = String(thread.thread_id);
      let messages: unknown[];
      try {
        messages = JSON.parse(String(thread.messages)) as unknown[];
      } catch {
        // Ligne corrompue : ignorée (jamais supprimée — restauration manuelle
        // possible), boot avec avertissement au lieu du crash.
        skipped += 1;
        continue;
      }
      globalStore.getOrCreate(threadId);
      const runs = this.db
        .prepare(
          'SELECT run_id, agent_id, parent_run_id, events, created_at FROM runner_runs WHERE thread_id = ? ORDER BY seq',
        )
        .all(threadId) as Array<Record<string, unknown>>;
      for (const run of runs) {
        let events: unknown[];
        try {
          events = JSON.parse(String(run.events)) as unknown[];
        } catch {
          skipped += 1;
          continue;
        }
        globalStore.appendRun(threadId, {
          runId: String(run.run_id),
          agentId: run.agent_id == null ? null : String(run.agent_id),
          parentRunId:
            run.parent_run_id == null ? null : String(run.parent_run_id),
          events,
          messages,
          createdAt: Number(run.created_at),
        });
      }
    }
    if (skipped)
      console.warn(
        `SqliteAgentRunner: ${skipped} ligne(s) corrompue(s) ignorée(s) au boot (conservées en DB pour restauration manuelle).`,
      );
  }

  private persist(threadId: string) {
    const thread = globalStore.peek(threadId);
    if (!thread) return;
    this.db
      .prepare('DELETE FROM runner_runs WHERE thread_id = ?')
      .run(threadId);
    const insert = this.db.prepare(
      'INSERT INTO runner_runs (thread_id, run_id, agent_id, parent_run_id, events, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const run of thread.historicRuns) {
      insert.run(
        threadId,
        run.runId,
        run.agentId ?? 'default',
        run.parentRunId ?? null,
        JSON.stringify(run.events ?? []),
        run.createdAt ?? Date.now(),
      );
    }
    const createdAt = thread.historicRuns[0]?.createdAt ?? Date.now();
    this.db
      .prepare(
        'INSERT INTO runner_threads (thread_id, messages, created_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET messages = excluded.messages',
      )
      .run(threadId, JSON.stringify(thread.messagesSnapshot ?? []), createdAt);
  }

  override run(request: AgentRunnerRunRequest) {
    const observable = super.run(request);
    observable.subscribe({ complete: () => this.persist(request.threadId) });
    return observable;
  }

  /** Drop a thread's persisted and in-memory history. */
  deleteThread(threadId: string) {
    this.db
      .prepare('DELETE FROM runner_runs WHERE thread_id = ?')
      .run(threadId);
    this.db
      .prepare('DELETE FROM runner_threads WHERE thread_id = ?')
      .run(threadId);
    const thread = globalStore.peek(threadId);
    if (thread) {
      thread.historicRuns.length = 0;
      thread.messagesSnapshot = [];
    }
  }

  override clearThreads() {
    super.clearThreads();
    this.db.exec('DELETE FROM runner_runs; DELETE FROM runner_threads;');
  }
}
