import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { safeJsonParse } from './safe-json.js';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';
const DEFAULT_PERMISSIONS: ComputerPermissions = {
  enabled: false,
  browser: false,
  files: false,
  shell: false,
};
/**
 * C2 — permissions ordinateur + journal d'audit, PORTÉS par compte.
 * Les lignes sont rattachées à un Dot ; le propriétaire est celui du Dot
 * (table `dots`). Un store non lié ne voit rien, ses écritures lèvent.
 */
export class ComputerStore {
  constructor(
    private db: DatabaseSync,
    readonly userId: string | null = null,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
    // Migration C2 : les bases créées avant C2 n'ont pas user_id.
    for (const table of ['computer_permissions', 'computer_audit']) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === 'user_id')
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
    }
  }
  /** Même instance portée par cet utilisateur, même connexion DB. */
  forUser(userId: string): ComputerStore {
    return new ComputerStore(this.db, userId);
  }
  private requireUser(): string {
    if (this.userId === null)
      throw new Error('ComputerStore: no user bound (call forUser first).');
    return this.userId;
  }
  /**
   * Migration (système) : chaque ligne est réclamée par le propriétaire
   * de son Dot (résolu via `dots.user_id`), jamais par un compte arbitraire.
   */
  claimOrphans() {
    this.db.exec(
      `UPDATE computer_permissions SET user_id=(SELECT user_id FROM dots WHERE dots.id=computer_permissions.dotId) WHERE user_id IS NULL;
       UPDATE computer_audit SET user_id=(SELECT user_id FROM dots WHERE dots.id=computer_audit.dotId) WHERE user_id IS NULL;`,
    );
  }
  permissions(id: string): ComputerPermissions {
    const row = this.db
      .prepare(
        'SELECT value FROM computer_permissions WHERE dotId=? AND user_id=?',
      )
      .get(id, this.userId);
    return row
      ? safeJsonParse(
          String(row.value),
          DEFAULT_PERMISSIONS,
          `computer_permissions:${id}`,
        )
      : DEFAULT_PERMISSIONS;
  }
  patch(id: string, patch: Partial<ComputerPermissions>) {
    const userId = this.requireUser();
    const value = { ...this.permissions(id), ...patch };
    this.db
      .prepare('INSERT OR REPLACE INTO computer_permissions VALUES (?,?,?)')
      .run(id, JSON.stringify(value), userId);
    return value;
  }
  begin(dotId: string, action: string, actor: 'owner' | 'agent') {
    const userId = this.requireUser();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO computer_audit VALUES (?,?,?,?,?,?,?)')
      .run(id, dotId, action, actor, 'pending', Date.now(), userId);
    return id;
  }
  finish(id: string, outcome: 'succeeded' | 'failed') {
    this.db
      .prepare('UPDATE computer_audit SET outcome=? WHERE id=? AND user_id=?')
      .run(outcome, id, this.userId);
    this.db
      .prepare(
        `DELETE FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=? AND user_id=?) AND outcome!='pending' AND id NOT IN (SELECT id FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=? AND user_id=?) AND outcome!='pending' ORDER BY createdAt DESC,rowid DESC LIMIT 1000)`,
      )
      .run(id, this.userId, id, this.userId);
  }
  audit(id: string): ComputerAudit[] {
    return this.db
      .prepare(
        'SELECT id,action,actor,outcome,createdAt FROM computer_audit WHERE dotId=? AND user_id=? ORDER BY createdAt DESC LIMIT 50',
      )
      .all(id, this.userId) as unknown as ComputerAudit[];
  }
}
