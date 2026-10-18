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
  user_id?: string;
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
/** ConnectionStore — Phase C1 : toutes les requêtes filtrent par user_id. */
export class ConnectionStore {
  constructor(
    private db: DatabaseSync,
    private secretProvider?: () => string,
    /** Legacy READ-only key (OWNER_TOKEN): decrypts values sealed before
     * SECRETS_KEY became the only sealing key. Never seals. */
    private legacySecretProvider?: () => string,
    readonly userId: string | null = null,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT, tools TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS mcp_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, createdAt INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS mcp_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, user_id TEXT, PRIMARY KEY(threadId, toolCallId));`);
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
      `CREATE TABLE IF NOT EXISTS mcp_approval_claims(approvalId TEXT PRIMARY KEY, threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, createdAt INTEGER NOT NULL, user_id TEXT)`,
    );
    for (const table of [
      'mcp_connections',
      'mcp_approvals',
      'mcp_actions',
      'mcp_approval_claims',
    ]) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === 'user_id')
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
    }
    // Re-gating Lot 1, une seule fois par base (marqueur système,
    // user_id='' : global, pas un compte) : les choix owner postérieurs
    // sont respectés. `app_config` peut ne pas exister sur une base nue de
    // test → on saute silencieusement dans ce cas.
    try {
      const marked = this.db
        .prepare("SELECT value FROM app_config WHERE key=? AND user_id=''")
        .get(REGATE_MARKER);
      if (!marked) {
        regateLegacyMcpTools(this.db);
        this.db
          .prepare(
            "INSERT INTO app_config(user_id, key, value) VALUES ('', ?, ?)",
          )
          .run(REGATE_MARKER, '1');
      }
    } catch {
      /* bare DatabaseSync without app_config (unit scope): skip */
    }
    this.migrateTokens();
  }
  /** Même instance portée par cet utilisateur, même connexion DB. */
  forUser(userId: string): ConnectionStore {
    return new ConnectionStore(
      this.db,
      this.secretProvider,
      this.legacySecretProvider,
      userId,
    );
  }
  private requireUser(): string {
    if (this.userId === null)
      throw new Error('ConnectionStore: no user bound (call forUser first).');
    return this.userId;
  }
  /** Migration (système) : réclame les lignes orphelines. Idempotente. */
  claimOrphans(userId: string) {
    for (const table of [
      'mcp_connections',
      'mcp_approvals',
      'mcp_actions',
      'mcp_approval_claims',
    ])
      this.db
        .prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`)
        .run(userId);
  }
  /** Encrypt-at-rest for MCP bearer tokens. Legacy plaintext or `enc1` rows
   * are re-sealed once, idempotently, with SECRETS_KEY. Refuses to store
   * plaintext when no sealing key is configured (fail closed). */
  private secret(): string | undefined {
    try {
      return this.secretProvider?.();
    } catch {
      return undefined;
    }
  }
  private legacySecret(): string {
    try {
      return this.legacySecretProvider?.() ?? '';
    } catch {
      return '';
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
    return decryptSecret(stored, this.secret() ?? '', this.legacySecret());
  }
  private migrateTokens() {
    if (!this.secretProvider) return;
    // Non porté (root) : toutes les lignes (système, comme avant).
    // Porté : seulement les lignes de ce compte.
    const rows = this.db
      .prepare(
        `SELECT id, token FROM mcp_connections WHERE token IS NOT NULL ${this.userId ? 'AND user_id=?' : ''}`,
      )
      .all(...(this.userId ? [this.userId] : [])) as unknown as {
      id: string;
      token: string;
    }[];
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
        `SELECT * FROM mcp_connections WHERE user_id=? ${dotId ? 'AND dotId=?' : ''} ORDER BY createdAt, rowid`,
      )
      .all(
        ...(dotId ? [this.userId, dotId] : [this.userId]),
      ) as unknown as Row[];
  }
  private view(row: Row): Connection {
    const { token, tools, user_id: _userId, ...rest } = row;
    void _userId;
    return {
      ...rest,
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
    const userId = this.requireUser();
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO mcp_connections VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
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
        userId,
      );
    return this.get(id)!;
  }
  saveTools(id: string, tools: ConnectionTool[], error: string | null = null) {
    this.requireUser();
    this.db
      .prepare(
        'UPDATE mcp_connections SET tools=?, error=?, updatedAt=? WHERE id=? AND user_id=?',
      )
      .run(JSON.stringify(tools), error, this.tick(id), id, this.userId);
    return this.get(id)!;
  }
  setError(id: string, error: string) {
    this.requireUser();
    this.db
      .prepare(
        'UPDATE mcp_connections SET error=?, updatedAt=? WHERE id=? AND user_id=?',
      )
      .run(error, this.tick(id), id, this.userId);
    return this.get(id)!;
  }
  remove(id: string) {
    this.requireUser();
    return (
      this.db
        .prepare('DELETE FROM mcp_connections WHERE id=? AND user_id=?')
        .run(id, this.userId).changes > 0
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
    const userId = this.requireUser();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO mcp_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        value.threadId,
        value.dotId,
        value.connectionId,
        value.tool,
        JSON.stringify(value.arguments),
        Date.now(),
        userId,
      );
    return id;
  }
  approval(id: string) {
    const row = this.db
      .prepare('SELECT * FROM mcp_approvals WHERE id=? AND user_id=?')
      .get(id, this.userId);
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
        'SELECT status, result, approvalId FROM mcp_actions WHERE threadId=? AND toolCallId=? AND user_id=?',
      )
      .get(threadId, toolCallId, this.userId);
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
    const userId = this.requireUser();
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO mcp_actions (threadId, toolCallId, connectionId, tool, status, result, createdAt, approvalId, user_id) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, ?)",
        )
        .run(
          threadId,
          toolCallId,
          connectionId,
          tool,
          Date.now(),
          approvalId,
          userId,
        ).changes > 0
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
    const userId = this.requireUser();
    const inserted =
      this.db
        .prepare(
          'INSERT OR IGNORE INTO mcp_approval_claims (approvalId, threadId, toolCallId, createdAt, user_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(approvalId, threadId, toolCallId, Date.now(), userId).changes > 0;
    if (inserted) return 'claimed';
    const row = this.db
      .prepare(
        'SELECT threadId, toolCallId FROM mcp_approval_claims WHERE approvalId=? AND user_id=?',
      )
      .get(approvalId, userId) as unknown as {
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
    this.requireUser();
    this.db
      .prepare(
        "UPDATE mcp_actions SET status='done', result=? WHERE threadId=? AND toolCallId=? AND user_id=?",
      )
      .run(JSON.stringify(result), threadId, toolCallId, this.userId);
  }
}
