import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/** Phase A (comptes multi-utilisateurs) : utilisateurs, sessions révoquables,
 *  codes de réinitialisation à usage unique, journal d'audit auth. L'auth par
 *  jeton OWNER_TOKEN coexiste pendant cette phase (non branchée : la
 *  session n'autorise pas encore les routes /api — Phase B). */

export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const USERNAME_MAX_LENGTH = 64;
/** Session : inactivité 24 h / absolu 7 j (décisions verrouillées). */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** Code de réinitialisation : usage unique, expire en 1 h. */
const RESET_TTL_MS = 60 * 60 * 1000;
/** argon2id (hash-wasm, WASM pur) : sel 16 octets, m ≥ 64 MiB, t ≥ 3, p = 1. */
const ARGON2 = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
};

export type UserRole = 'admin' | 'user';
export interface User {
  id: string;
  username: string;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}
export interface UserRow extends User {
  passwordHash: string;
}
interface DbUserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  disabled: number;
  createdAt: number;
  lastLoginAt: number | null;
}
export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
export interface AuthAuditEvent {
  id: number;
  action: string;
  username: string;
  ip: string;
  at: number;
}

/** Mot de passe maître Admin : fail-closed au boot, comme OWNER_TOKEN. */
export function resolveAdminMasterPassword(): string {
  const value = process.env.ADMIN_MASTER_PASSWORD?.trim();
  if (!value)
    throw new Error(
      'ADMIN_MASTER_PASSWORD is required: set a strong master password, used to bootstrap the first admin account and to create/delete accounts.',
    );
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    ...ARGON2,
    outputType: 'encoded',
  });
}
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}
// Hash fictif (timing constant quand l'utilisateur n'existe pas : on ne
// révèle jamais si le compte existe).
let dummyHash: string | null = null;
async function dummyHashValue(): Promise<string> {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  return dummyHash;
}
export async function verifyPasswordOrDummy(
  password: string,
  hash: string | null,
): Promise<boolean> {
  if (hash) return verifyPassword(password, hash);
  await verifyPassword(password, await dummyHashValue());
  return false;
}

/** Les secrets stockés (session, code reset) sont hachés : une fuite de la
 *  base ne donne pas de secret utilisable. Le cookie porte la valeur brute. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class AuthStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastLoginAt INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, userId TEXT NOT NULL, expiresAt INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, username TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE INDEX IF NOT EXISTS auth_audit_at ON auth_audit(at);`);
  }
  close() {
    this.db.close();
  }

  /** Phase B (bootstrap) : nombre de comptes (0 = premier compte à créer). */
  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as {
      n: number;
    };
    return row.n;
  }

  async createUser(
    username: string,
    password: string,
    role: UserRole,
    // Tests uniquement : id déterministe ('owner') pour aligner les
    // fixtures (stores liés) avec l'utilisateur de session. En prod,
    // toujours un UUID aléatoire.
    id: string = randomUUID(),
  ): Promise<User> {
    const name = username.trim();
    if (name.length < 1 || name.length > USERNAME_MAX_LENGTH)
      throw new Error('Username must be 1–64 characters.');
    if (
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH
    )
      throw new Error(
        `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`,
      );
    const now = Date.now();
    try {
      this.db
        .prepare(
          'INSERT INTO users (id, username, passwordHash, role, disabled, createdAt, lastLoginAt) VALUES (?, ?, ?, ?, 0, ?, NULL)',
        )
        .run(id, name, await hashPassword(password), role, now);
    } catch {
      throw new Error('Username already exists.');
    }
    return {
      id,
      username: name,
      role,
      disabled: false,
      createdAt: now,
      lastLoginAt: null,
    };
  }
  getUserByUsername(username: string): UserRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username=?')
      .get(username.trim()) as DbUserRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.passwordHash,
      role: row.role,
      disabled: row.disabled === 1,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    };
  }
  setUserDisabled(id: string, disabled: boolean) {
    this.db
      .prepare('UPDATE users SET disabled=? WHERE id=?')
      .run(disabled ? 1 : 0, id);
  }
  /** Phase B (reset) : change le mot de passe (validé, haché). */
  async setUserPassword(id: string, password: string) {
    if (
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH
    )
      throw new Error(
        `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`,
      );
    this.db
      .prepare('UPDATE users SET passwordHash=? WHERE id=?')
      .run(await hashPassword(password), id);
  }
  getUserById(id: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as
      DbUserRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.passwordHash,
      role: row.role,
      disabled: row.disabled === 1,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    };
  }
  setUserRole(id: string, role: UserRole) {
    this.db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
  }
  setLastLogin(id: string, now = Date.now()) {
    this.db.prepare('UPDATE users SET lastLoginAt=? WHERE id=?').run(now, id);
  }

  createSession(
    userId: string,
    now = Date.now(),
  ): { rawId: string; session: Session } {
    const rawId = randomBytes(32).toString('hex');
    const session: Session = {
      id: hashToken(rawId),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_MAX_MS,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, userId, createdAt, lastSeenAt, expiresAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.userId,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      );
    return { rawId, session };
  }
  getSession(rawId: string, now = Date.now()): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id=?')
      .get(hashToken(rawId)) as Session | undefined;
    if (!row) return undefined;
    if (now > row.expiresAt || now - row.lastSeenAt > SESSION_IDLE_MS) {
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id);
      return undefined;
    }
    this.db
      .prepare('UPDATE sessions SET lastSeenAt=? WHERE id=?')
      .run(now, row.id);
    return { ...row, lastSeenAt: now };
  }
  revokeSession(rawId: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(hashToken(rawId));
  }
  /** Id du premier compte créé (Admin du bootstrap) — pour la migration C1. */
  firstUserId(): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM users ORDER BY createdAt LIMIT 1')
      .get() as { id?: string } | undefined;
    return typeof row?.id === 'string' ? row.id : undefined;
  }
  revokeAllSessions(userId: string) {
    this.db.prepare('DELETE FROM sessions WHERE userId=?').run(userId);
  }
  sweepExpiredSessions(now = Date.now()): number {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE expiresAt < ? OR lastSeenAt < ?')
      .run(now, now - SESSION_IDLE_MS);
    return Number(result.changes);
  }

  createPasswordReset(userId: string, now = Date.now()): { rawToken: string } {
    const rawToken = randomBytes(32).toString('hex');
    this.db
      .prepare(
        'INSERT INTO password_resets (id, userId, expiresAt, used) VALUES (?, ?, ?, 0)',
      )
      .run(hashToken(rawToken), userId, now + RESET_TTL_MS);
    return { rawToken };
  }
  verifyPasswordReset(
    rawToken: string,
    now = Date.now(),
  ): { userId: string } | undefined {
    const row = this.db
      .prepare('SELECT * FROM password_resets WHERE id=?')
      .get(hashToken(rawToken)) as
      { userId: string; expiresAt: number; used: number } | undefined;
    if (!row || row.used !== 0 || now > row.expiresAt) return undefined;
    return { userId: row.userId };
  }
  consumePasswordReset(rawToken: string) {
    this.db
      .prepare('DELETE FROM password_resets WHERE id=?')
      .run(hashToken(rawToken));
  }
  /** Phase B : purge les codes expirés (lignes mortes, comme les sessions). */
  sweepExpiredResets(now = Date.now()): number {
    const result = this.db
      .prepare('DELETE FROM password_resets WHERE expiresAt < ?')
      .run(now);
    return Number(result.changes);
  }

  logAuthEvent(action: string, username: string, ip: string, at = Date.now()) {
    this.db
      .prepare(
        'INSERT INTO auth_audit (action, username, ip, at) VALUES (?, ?, ?, ?)',
      )
      .run(action, username, ip, at);
  }
  listAuthEvents(limit = 100): AuthAuditEvent[] {
    return this.db
      .prepare('SELECT * FROM auth_audit ORDER BY at DESC LIMIT ?')
      .all(limit) as unknown as AuthAuditEvent[];
  }
}
