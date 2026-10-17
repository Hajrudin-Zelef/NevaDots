import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isLegacySecret } from './secrets.js';
import { safeJsonParse } from './safe-json.js';
import type {
  Connection,
  ConnectionActionResult,
  ConnectionTool,
} from '../shared/connection-types.js';
type Row = Omit<Connection, 'hasToken' | 'tools'> & {
  token: string | null;
  tools: string;
};
/** Marqueur de la migration one-shot ci-dessous. */
const REGATE_MARKER = 'mcp_regated_v1';
/**
 * One-shot Lot 1 (fail-open `readOnlyHint`) : re-gate les outils restés
 * `requiresApproval: false` par l'ancien défaut. Retourne le nombre d'outils
 * re-gatés. Idempotent : un second passage ne change rien.
 */
export function regateLegacyMcpTools(db: DatabaseSync): number {
  let flipped = 0;
  const rows = db
    .prepare('SELECT id, tools FROM mcp_connections')
    .all() as unknown as Array<{ id: string; tools: string }>;
  for (const row of rows) {
    let tools: ConnectionTool[];
    try {
      tools = JSON.parse(row.tools) as ConnectionTool[];
    } catch {
      continue;
    }
    if (!Array.isArray(tools)) continue;
    let changed = false;
    for (const tool of tools) {
      if (tool.requiresApproval === false) {
        tool.requiresApproval = true;
        changed = true;
        flipped += 1;
      }
    }
    if (changed)
      db.prepare('UPDATE mcp_connections SET tools=? WHERE id=?').run(
        JSON.stringify(tools),
        row.id,
      );
  }
  return flipped;
}
export class ConnectionStore {
  constructor(
    private db: DatabaseSync,
    private secretProvider?: () => string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT, tools TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, toolCallId));`);
    // A receipt belongs to the approval that produced it.
    if (
      !db
        .prepare('PRAGMA table_info(mcp_actions)')
        .all()
        .some((column) => column.name === 'approvalId')
    )
      db.exec('ALTER TABLE mcp_actions ADD COLUMN approvalId TEXT');
    // One execution per approval: the first (threadId, toolCallId) pair to
    // claim an approvalId owns it; any other pair is rejected.
    db.exec(
      `CREATE TABLE IF NOT EXISTS mcp_approval_claims(approvalId TEXT PRIMARY KEY, threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, createdAt INTEGER NOT NULL)`,
    );
    // Re-gating Lot 1, une seule fois par base (marqueur) : les choix owner
    // postérieurs sont respectés. `app_config` peut ne pas exister sur une
    // base nue de test → on saute silencieusement dans ce cas.
    try {
      const marked = this.db
        .prepare('SELECT value FROM app_config WHERE key=?')
        .get(REGATE_MARKER);
      if (!marked) {
        regateLegacyMcpTools(this.db);
        this.db
          .prepare('INSERT INTO app_config(key, value) VALUES (?, ?)')
          .run(REGATE_MARKER, '1');
      }
    } catch {
      /* bare DatabaseSync without app_config (unit scope): skip */
    }
    this.migrateTokens();
  }
  /** Encrypt-at-rest for MCP bearer tokens. Legacy plaintext or `enc1` rows
   * are re-sealed once, idempotently, using the server secret. Refuses to
   * store plaintext when no secret is configured (fail closed). */
  private secret(): string | undefined {
    try {
      return this.secretProvider?.();
    } catch {
      return undefined;
    }
  }
  private seal(plain: string): string {
    return encryptSecret(plain, this.secret() ?? '');
  }
  private static sealed(stored: string): boolean {
    return stored.startsWith('enc2:') || stored.startsWith('enc1:');
  }
  private open(stored: string): string {
    if (!ConnectionStore.sealed(stored)) return stored;
    return decryptSecret(stored, this.secret() ?? '');
  }
  private migrateTokens() {
    if (!this.secretProvider) return;
    const rows = this.db
      .prepare('SELECT id, token FROM mcp_connections WHERE token IS NOT NULL')
      .all() as unknown as { id: string; token: string }[];
    for (const row of rows) {
      if (!isLegacySecret(row.token)) continue;
      this.db
        .prepare('UPDATE mcp_connections SET token=? WHERE id=?')
        .run(this.seal(row.token), row.id);
    }
  }
  private rows(dotId?: string) {
    return this.db
      .prepare(
        `SELECT * FROM mcp_connections ${dotId ? 'WHERE dotId=?' : ''} ORDER BY createdAt, rowid`,
      )
      .all(...(dotId ? [dotId] : [])) as unknown as Row[];
  }
  private view({ token, tools, ...row }: Row): Connection {
    return {
      ...row,
      hasToken: !!token,
      tools: safeJsonParse<ConnectionTool[]>(
        tools,
        [],
        `mcp_connections.tools:${row.id}`,
      ),
    };
  }
  list(dotId: string): Connection[] {
    return this.rows(dotId).map((row) => this.view(row));
  }
  get(id: string): Connection | undefined {
    const row = this.rows().find((row) => row.id === id);
    return row && this.view(row);
  }
  // Secrets never leave the server: only the MCP transport reads them.
  // Tokens are AES-GCM sealed at rest; a corrupt entry fails closed.
  credentials(id: string) {
    const row = this.rows().find((row) => row.id === id);
    if (!row) throw new Error('Connection not found.');
    if (row.token == null) return { url: row.url, token: undefined };
    let token: string;
    try {
      token = this.open(row.token);
    } catch {
      throw new Error(
        'The stored credential is unreadable. Re-enter the bearer token.',
      );
    }
    return { url: row.url, token: token || undefined };
  }
  create(
    dotId: string,
    value: { name: string; url: string; token?: string },
    tools: ConnectionTool[],
  ): Connection {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO mcp_connections VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(
        id,
        dotId,
        value.name,
        value.url,
        value.token ? this.seal(value.token) : null,
        JSON.stringify(tools),
        now,
        now,
      );
    return this.get(id)!;
  }
  saveTools(id: string, tools: ConnectionTool[], error: string | null = null) {
    this.db
      .prepare(
        'UPDATE mcp_connections SET tools=?, error=?, updatedAt=? WHERE id=?',
      )
      .run(JSON.stringify(tools), error, this.tick(id), id);
    return this.get(id)!;
  }
  setError(id: string, error: string) {
    this.db
      .prepare('UPDATE mcp_connections SET error=?, updatedAt=? WHERE id=?')
      .run(error, this.tick(id), id);
    return this.get(id)!;
  }
  remove(id: string) {
    return (
      this.db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id)
        .changes > 0
    );
  }
  // Running turns compare this to stop as soon as the owner changes access.
  fingerprint(dotId: string) {
    return this.rows(dotId)
      .map((row) => `${row.id}:${row.updatedAt}`)
      .join(',');
  }
  // Keep updatedAt strictly increasing so rapid edits always change the fingerprint.
  private tick(id: string) {
    return Math.max(Date.now(), (this.get(id)?.updatedAt ?? 0) + 1);
  }
  // Binds a gated call to its exact connection, tool, and arguments, so a
  // later approval runs that call and nothing else.
  createApproval(value: {
    threadId: string;
    dotId: string;
    connectionId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO mcp_approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        value.threadId,
        value.dotId,
        value.connectionId,
        value.tool,
        JSON.stringify(value.arguments),
        Date.now(),
      );
    return id;
  }
  approval(id: string) {
    const row = this.db
      .prepare('SELECT * FROM mcp_approvals WHERE id=?')
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      threadId: String(row.threadId),
      dotId: String(row.dotId),
      connectionId: String(row.connectionId),
      tool: String(row.tool),
      arguments: safeJsonParse<Record<string, unknown>>(
        String(row.arguments),
        {},
        'mcp_approvals.arguments',
      ),
      createdAt: Number(row.createdAt),
    };
  }
  action(threadId: string, toolCallId: string) {
    const row = this.db
      .prepare(
        'SELECT status, result, approvalId FROM mcp_actions WHERE threadId=? AND toolCallId=?',
      )
      .get(threadId, toolCallId);
    if (!row) return undefined;
    return {
      approvalId: typeof row.approvalId === 'string' ? row.approvalId : null,
      status: String(row.status) as 'running' | 'done',
      result:
        typeof row.result === 'string'
          ? safeJsonParse<ConnectionActionResult>(
              row.result,
              null as never,
              'mcp_actions.result',
            )
          : null,
    };
  }
  // Claim an approved action once. Returns false if it was already claimed,
  // so a double click or a retried request never executes twice.
  claimAction(
    threadId: string,
    toolCallId: string,
    approvalId: string,
    connectionId: string,
    tool: string,
  ) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO mcp_actions (threadId, toolCallId, connectionId, tool, status, result, createdAt, approvalId) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
        )
        .run(threadId, toolCallId, connectionId, tool, Date.now(), approvalId)
        .changes > 0
    );
  }
  /**
   * Bind an approval to its first (threadId, toolCallId) pair. Returns
   * 'claimed' for the winner, 'same' when the identical pair retries
   * (idempotent recovery), and 'different' when the approval is replayed
   * under another call — which the route rejects without executing.
   */
  claimApproval(
    approvalId: string,
    threadId: string,
    toolCallId: string,
  ): 'claimed' | 'same' | 'different' {
    const inserted =
      this.db
        .prepare(
          'INSERT OR IGNORE INTO mcp_approval_claims (approvalId, threadId, toolCallId, createdAt) VALUES (?, ?, ?, ?)',
        )
        .run(approvalId, threadId, toolCallId, Date.now()).changes > 0;
    if (inserted) return 'claimed';
    const row = this.db
      .prepare(
        'SELECT threadId, toolCallId FROM mcp_approval_claims WHERE approvalId=?',
      )
      .get(approvalId) as unknown as {
      threadId: string;
      toolCallId: string;
    };
    return row.threadId === threadId && row.toolCallId === toolCallId
      ? 'same'
      : 'different';
  }
  finishAction(
    threadId: string,
    toolCallId: string,
    result: ConnectionActionResult,
  ) {
    this.db
      .prepare(
        "UPDATE mcp_actions SET status='done', result=? WHERE threadId=? AND toolCallId=?",
      )
      .run(JSON.stringify(result), threadId, toolCallId);
  }
}
