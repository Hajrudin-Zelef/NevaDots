import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  constants as zlibConstants,
  brotliCompress,
  brotliDecompress,
} from 'node:zlib';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

const FILE_NAME = 'notes.md.br';
const TRASH_DIR = 'trash';
const FLUSH_DEBOUNCE_MS = 1_500;
const FLUSH_RETRY_MS = 5_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

export const DEFAULT_RAM_LIMIT_BYTES = 1_073_741_824; // 1 GiB
export const DEFAULT_DISK_LIMIT_BYTES = 5_368_709_120; // 5 GiB
export const DEFAULT_RETENTION_MS = 5 * 24 * 60 * 60_000; // 5 jours
export const DEFAULT_MAX_SESSION_BYTES = 32_768; // 32 KiB de notes utiles
export const DEFAULT_PROMPT_BYTES = 2_048; // notes injectées dans le prompt

export interface SessionBrainOptions {
  rootDir?: string;
  ramLimitBytes?: number;
  diskLimitBytes?: number;
  retentionMs?: number;
  maxSessionBytes?: number;
  promptBytes?: number;
  now?: () => number;
}

export interface SessionBrainScope {
  userId: string;
  dotId: string;
  threadId: string;
}

export interface SessionBrainPrompt {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface SessionBrainWriteResult {
  ok: boolean;
  bytes: number;
  reason?: string;
}

export interface SessionBrainStats {
  ramBytes: number;
  entries: number;
  diskBytes: number;
}

interface CacheEntry {
  dir: string;
  content: string;
  bytes: number;
  dirty: boolean;
  version: number;
  timer?: NodeJS.Timeout;
}

/**
 * Cerveau de session par thread chat.
 *
 * - Chaque session (userId + Dot + threadId) a son dossier indépendant.
 * - Les notes chaudes vivent en RAM (LRU, 1 GiB par défaut) et sont écrites
 *   en arrière-plan, compressées en Brotli, sur disque.
 * - Le disque est plafonné à 5 GiB ; les sessions supprimées partent dans
 *   `trash/` et y restent 5 jours avant purge.
 * - Toutes les erreurs de stockage sont non bloquantes : un tour ne casse
 *   jamais parce que le cerveau de session est indisponible.
 */
export class SessionBrainStore {
  readonly root: string;
  private readonly ramLimitBytes: number;
  private readonly diskLimitBytes: number;
  private readonly retentionMs: number;
  private readonly maxSessionBytes: number;
  private readonly promptBytes: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly deleted = new Set<string>();
  private readonly purgedUsers = new Set<string>();
  private ramBytes = 0;
  private diskBytes = 0;
  private interval?: NodeJS.Timeout;
  private started = false;
  private closed = false;

  constructor(options: SessionBrainOptions = {}) {
    this.root = resolve(
      options.rootDir ?? process.env.SESSION_BRAIN_DIR ?? 'data/session-brains',
    );
    this.ramLimitBytes = positive(
      options.ramLimitBytes ?? numericEnv('SESSION_BRAIN_RAM_BYTES'),
      DEFAULT_RAM_LIMIT_BYTES,
    );
    this.diskLimitBytes = positive(
      options.diskLimitBytes ?? numericEnv('SESSION_BRAIN_DISK_BYTES'),
      DEFAULT_DISK_LIMIT_BYTES,
    );
    this.retentionMs = positive(
      options.retentionMs ?? numericEnv('SESSION_BRAIN_RETENTION_MS'),
      DEFAULT_RETENTION_MS,
    );
    this.maxSessionBytes = positive(
      options.maxSessionBytes ?? numericEnv('SESSION_BRAIN_MAX_BYTES'),
      DEFAULT_MAX_SESSION_BYTES,
    );
    this.promptBytes = positive(
      options.promptBytes ?? numericEnv('SESSION_BRAIN_PROMPT_BYTES'),
      DEFAULT_PROMPT_BYTES,
    );
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sweep().catch((error) => this.report('sweep', error));
    this.interval = setInterval(() => {
      void this.sweep().catch((error) => this.report('sweep', error));
    }, SWEEP_INTERVAL_MS);
    this.interval.unref?.();
  }

  async sweepNow(): Promise<void> {
    await this.sweep();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    await this.flushNow();
    await Promise.all(this.queues.values());
  }

  async read(scope: SessionBrainScope): Promise<string> {
    const target = this.scope(scope);
    if (
      this.deleted.has(target.key) ||
      this.purgedUsers.has(segment(scope.userId))
    )
      return '';
    const cached = this.touch(target.key);
    if (cached) return cached.content;
    let content = '';
    try {
      const raw = await fs.readFile(target.file);
      content = (await decompress(raw)).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.report('read', error);
    }
    this.setCache(target, content, false);
    return content;
  }

  async promptNotes(scope: SessionBrainScope): Promise<SessionBrainPrompt> {
    const content = await this.read(scope);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.length <= this.promptBytes)
      return { text: content, truncated: false, bytes };
    return {
      text: `${content.slice(0, this.promptBytes)}\n…[tronqué — session_brain_read pour le reste]`,
      truncated: true,
      bytes,
    };
  }

  async append(
    scope: SessionBrainScope,
    note: string,
  ): Promise<SessionBrainWriteResult> {
    const text = note.trim();
    if (!text) return { ok: false, bytes: 0, reason: 'Empty note ignored.' };
    const current = await this.read(scope);
    const line = text.startsWith('- ') ? text : `- ${text}`;
    const next = current.trim()
      ? `${current.trimEnd()}\n${line}\n`
      : `# Session notes\n\n${line}\n`;
    return this.write(scope, next);
  }

  async write(
    scope: SessionBrainScope,
    content: string,
  ): Promise<SessionBrainWriteResult> {
    if (this.closed)
      return { ok: false, bytes: 0, reason: 'Session brain is closing.' };
    const target = this.scope(scope);
    if (
      this.deleted.has(target.key) ||
      this.purgedUsers.has(segment(scope.userId))
    )
      return { ok: false, bytes: 0, reason: 'Session brain was deleted.' };
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxSessionBytes)
      return {
        ok: false,
        bytes,
        reason: `Session notes exceed ${this.maxSessionBytes} bytes; use session_brain_write to compact them first.`,
      };
    const entry =
      this.cache.get(target.key) ??
      ({
        dir: target.dir,
        content: '',
        bytes: 0,
        dirty: false,
        version: 0,
      } satisfies CacheEntry);
    this.ramBytes += bytes - entry.bytes;
    entry.content = content;
    entry.bytes = bytes;
    entry.version += 1;
    entry.dirty = true;
    this.cache.delete(target.key);
    this.cache.set(target.key, entry);
    this.enforceRam();
    this.scheduleFlush(target.key, entry);
    return { ok: true, bytes };
  }

  /**
   * Suppression d'une session : vide la RAM immédiatement, puis déplace le
   * dossier disque dans `trash/` (conservé `retentionMs`, 5 jours par défaut).
   */
  async flushNow(): Promise<void> {
    await Promise.all(
      [...this.cache.entries()].map(([key]) => this.flushKey(key)),
    );
  }

  async deleteThread(scope: SessionBrainScope): Promise<void> {
    const target = this.scope(scope);
    this.deleted.add(target.key);
    await this.flushKey(target.key);
    await this.drainKey(target.key);
    const entry = this.cache.get(target.key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.dropCache(target.key);
    await this.moveToTrash(target.dir);
  }

  /** Suppression de compte : purge immédiate, y compris la corbeille. */
  async purgeUser(userId: string): Promise<void> {
    const user = segment(userId);
    this.purgedUsers.add(user);
    const keys: string[] = [];
    for (const key of [...this.cache.keys()]) {
      const entry = this.cache.get(key);
      if (!entry) continue;
      if (entry.dir.startsWith(join(this.root, user) + '/')) {
        keys.push(key);
        if (entry.timer) clearTimeout(entry.timer);
        this.dropCache(key);
      }
    }
    const inFlight = [...this.queues.entries()]
      .filter(([key]) => key.startsWith(`${user}\0`))
      .map(([, pending]) => pending);
    await Promise.all([...keys.map((key) => this.drainKey(key)), ...inFlight]);
    await fs.rm(join(this.root, user), { recursive: true, force: true });
    await fs.rm(join(this.root, TRASH_DIR, user), {
      recursive: true,
      force: true,
    });
    await this.sweep();
  }

  stats(): SessionBrainStats {
    return {
      ramBytes: this.ramBytes,
      entries: this.cache.size,
      diskBytes: this.diskBytes,
    };
  }

  private scope(scope: SessionBrainScope) {
    const userId = segment(scope.userId);
    const dotId = segment(scope.dotId);
    const threadId = segment(scope.threadId);
    const dir = join(this.root, userId, dotId, threadId);
    return {
      key: `${userId}\0${dotId}\0${threadId}`,
      dir,
      file: join(dir, FILE_NAME),
    };
  }

  private touch(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  private setCache(
    target: { key: string; dir: string },
    content: string,
    dirty: boolean,
  ): void {
    const bytes = Buffer.byteLength(content, 'utf8');
    const previous = this.cache.get(target.key);
    if (previous) this.ramBytes -= previous.bytes;
    this.ramBytes += bytes;
    this.cache.delete(target.key);
    this.cache.set(target.key, {
      dir: target.dir,
      content,
      bytes,
      dirty,
      version: (previous?.version ?? 0) + (dirty ? 1 : 0),
    });
    this.enforceRam();
  }

  private dropCache(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.ramBytes -= entry.bytes;
  }

  private enforceRam(): void {
    while (this.ramBytes > this.ramLimitBytes && this.cache.size > 0) {
      const [key, entry] = this.cache.entries().next().value as [
        string,
        CacheEntry,
      ];
      this.dropCache(key);
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.dirty) void this.flushEntry(key, entry);
    }
  }

  private scheduleFlush(key: string, entry: CacheEntry): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flushEntry(key, entry);
    }, FLUSH_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  private scheduleRetry(key: string, entry: CacheEntry): void {
    if (this.closed || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flushEntry(key, entry);
    }, FLUSH_RETRY_MS);
    entry.timer.unref?.();
  }

  private async flushKey(key: string): Promise<void> {
    const entry = this.cache.get(key);
    if (!entry || !entry.dirty) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    await this.flushEntry(key, entry);
  }

  private async drainKey(key: string): Promise<void> {
    const pending = this.queues.get(key);
    if (pending) await pending;
  }

  private async flushEntry(key: string, entry: CacheEntry): Promise<void> {
    if (!entry.dirty) return;
    const version = entry.version;
    const content = entry.content;
    await this.enqueue(key, async () => {
      try {
        await this.writeCompressed(entry.dir, content);
        if (entry.version === version) entry.dirty = false;
      } catch (error) {
        this.report('flush', error);
        this.scheduleRetry(key, entry);
      }
    });
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    this.queues.set(key, next);
    return next.catch(() => {
      // Une erreur de stockage ne doit jamais interrompre un tour.
    });
  }

  private async writeCompressed(dir: string, content: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, FILE_NAME);
    if (!content.trim()) {
      await fs.rm(file, { force: true });
      return;
    }
    const compressed = await compress(Buffer.from(content, 'utf8'), {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      },
    });
    const tmp = join(dir, `.${FILE_NAME}.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, compressed);
    await fs.rename(tmp, file);
  }

  private async moveToTrash(dir: string): Promise<void> {
    const rel = dir.slice(this.root.length + 1).split(/[\\/]/);
    const trash = join(
      this.root,
      TRASH_DIR,
      ...rel.slice(0, -1),
      `${rel.at(-1)}-${this.now()}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await fs.mkdir(join(trash, '..'), { recursive: true });
      await fs.rename(dir, trash);
      const stamp = new Date(this.now());
      await fs.utimes(trash, stamp, stamp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.report('trash', error);
    }
  }

  private async sweep(): Promise<void> {
    const active = await this.sessionDirs(this.root, 3, false);
    const trash = await this.sessionDirs(join(this.root, TRASH_DIR), 3, true);
    let total = 0;
    const trashRows: { path: string; bytes: number; mtime: number }[] = [];
    for (const row of trash) {
      const info = await this.dirInfo(row.path);
      total += info.bytes;
      trashRows.push({ path: row.path, bytes: info.bytes, mtime: row.mtime });
    }
    const activeRows: { path: string; bytes: number; mtime: number }[] = [];
    for (const row of active) {
      const info = await this.dirInfo(row.path);
      total += info.bytes;
      activeRows.push({ ...row, ...info });
    }

    const now = this.now();
    for (const row of trashRows) {
      if (now - row.mtime > this.retentionMs) {
        await fs.rm(row.path, { recursive: true, force: true });
        total -= row.bytes;
      }
    }
    if (total > this.diskLimitBytes) {
      const candidates = [...trashRows].sort((a, b) => a.mtime - b.mtime);
      for (const row of candidates) {
        if (total <= this.diskLimitBytes) break;
        if (!(await pathExists(row.path))) continue;
        await fs.rm(row.path, { recursive: true, force: true });
        total -= row.bytes;
      }
    }
    if (total > this.diskLimitBytes) {
      const cold = [...activeRows]
        .filter((row) => !this.isHot(row.path))
        .sort((a, b) => a.mtime - b.mtime);
      const hot = [...activeRows]
        .filter((row) => this.isHot(row.path))
        .sort((a, b) => a.mtime - b.mtime);
      for (const row of [...cold, ...hot]) {
        if (total <= this.diskLimitBytes) break;
        if (!(await pathExists(row.path))) continue;
        const key = this.keyForDir(row.path);
        if (key) {
          const entry = this.cache.get(key);
          if (entry?.timer) clearTimeout(entry.timer);
          await this.flushKey(key);
          if (entry?.timer) clearTimeout(entry.timer);
          this.dropCache(key);
        }
        await fs.rm(row.path, { recursive: true, force: true });
        total -= row.bytes;
      }
    }
    this.diskBytes = total;
  }

  private isHot(dir: string): boolean {
    for (const entry of this.cache.values()) if (entry.dir === dir) return true;
    return false;
  }

  private keyForDir(dir: string): string | undefined {
    for (const [key, entry] of this.cache) if (entry.dir === dir) return key;
    return undefined;
  }

  private async sessionDirs(
    base: string,
    depth: number,
    trash: boolean,
  ): Promise<{ path: string; mtime: number }[]> {
    const out: { path: string; mtime: number }[] = [];
    const walk = async (dir: string, level: number): Promise<void> => {
      if (level >= depth) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!trash && level === 0 && entry.name === TRASH_DIR) continue;
        const child = join(dir, entry.name);
        let stat;
        try {
          stat = await fs.lstat(child);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (level + 1 === depth) out.push({ path: child, mtime: stat.mtimeMs });
        else await walk(child, level + 1);
      }
    };
    await walk(base, 0);
    return out;
  }

  private async dirInfo(
    dir: string,
  ): Promise<{ bytes: number; mtime: number }> {
    let bytes = 0;
    let mtime = 0;
    const walk = async (current: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(current, entry.name);
        let stat;
        try {
          stat = await fs.lstat(child);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        mtime = Math.max(mtime, stat.mtimeMs);
        if (stat.isDirectory()) await walk(child);
        else if (stat.isFile()) bytes += stat.size;
      }
    };
    await walk(dir);
    return { bytes, mtime };
  }

  private report(operation: string, error: unknown): void {
    console.error(
      `Session brain ${operation} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : fallback;
}

function segment(value: string): string {
  if (/^[A-Za-z0-9._-]{1,200}$/.test(value) && value !== '.' && value !== '..')
    return value;
  return createHash('sha256').update(value).digest('hex');
}

function pathExists(path: string): Promise<boolean> {
  return fs
    .lstat(path)
    .then(() => true)
    .catch(() => false);
}
