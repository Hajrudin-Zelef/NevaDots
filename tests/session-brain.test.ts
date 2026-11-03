import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionBrainStore,
  type SessionBrainScope,
} from '../src/server/session-brain.js';

const roots: string[] = [];
const scope: SessionBrainScope = {
  userId: 'user-1',
  dotId: 'dot-1',
  threadId: 'thread-1',
};

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-brain-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  roots
    .splice(0)
    .reverse()
    .forEach((dir) => rmSync(dir, { recursive: true }));
});

describe('SessionBrainStore', () => {
  it('écrit des notes compressées, isolées par session et rechargeables', async () => {
    const dir = root();
    const store = new SessionBrainStore({
      rootDir: dir,
      promptBytes: 12,
    });
    const note = 'Décision importante et durable. '.repeat(20);
    await store.append(scope, note);
    await store.flushNow();
    const file = join(dir, 'user-1', 'dot-1', 'thread-1', 'notes.md.br');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).length).toBeLessThan(Buffer.byteLength(note));
    const other = {
      ...scope,
      threadId: 'thread-2',
    };
    expect(await store.read(other)).toBe('');
    const prompt = await store.promptNotes(scope);
    expect(prompt.text).toContain('[tronqué');
    const reloaded = new SessionBrainStore({ rootDir: dir });
    expect(await reloaded.read(scope)).toContain(
      'Décision importante et durable.',
    );
  });

  it('sert les données chaudes depuis la RAM après suppression du fichier', async () => {
    const dir = root();
    const store = new SessionBrainStore({ rootDir: dir });
    await store.append(scope, 'note chaude');
    await store.flushNow();
    const file = join(dir, 'user-1', 'dot-1', 'thread-1', 'notes.md.br');
    rmSync(file);
    expect(await store.read(scope)).toContain('note chaude');
  });

  it('évince le LRU au-delà du plafond RAM', async () => {
    const dir = root();
    const store = new SessionBrainStore({
      rootDir: dir,
      ramLimitBytes: 50,
      maxSessionBytes: 100,
    });
    const a = { ...scope, threadId: 'a' };
    const b = { ...scope, threadId: 'b' };
    expect((await store.write(a, 'x'.repeat(40))).ok).toBe(true);
    expect((await store.write(b, 'y'.repeat(40))).ok).toBe(true);
    expect(store.stats().ramBytes).toBeLessThanOrEqual(50);
    expect(store.stats().entries).toBe(1);
    expect(await store.read(b)).toContain('y');
  });

  it('refuse une session au-delà de son plafond', async () => {
    const store = new SessionBrainStore({
      rootDir: root(),
      maxSessionBytes: 5,
    });
    const result = await store.write(scope, '123456');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceed/i);
  });

  it('vide la RAM et conserve la session supprimée 5 jours dans trash', async () => {
    let now = 1_000_000;
    const retentionMs = 5 * 24 * 60 * 60_000;
    const dir = root();
    const store = new SessionBrainStore({
      rootDir: dir,
      retentionMs,
      now: () => now,
    });
    await store.append(scope, 'à conserver');
    await store.flushNow();
    await store.deleteThread(scope);
    expect(await store.read(scope)).toBe('');
    const trashParent = join(dir, 'trash', 'user-1', 'dot-1');
    expect(readdirSync(trashParent)).toHaveLength(1);
    now += retentionMs - 1;
    await store.sweepNow();
    expect(readdirSync(trashParent)).toHaveLength(1);
    now += 2;
    await store.sweepNow();
    expect(readdirSync(trashParent)).toHaveLength(0);
  });

  it('refuse toute écriture après suppression (course résumé auto)', async () => {
    const dir = root();
    const store = new SessionBrainStore({ rootDir: dir });
    await store.append(scope, 'note avant suppression');
    await store.deleteThread(scope);
    const result = await store.write(scope, 'ne doit pas revenir');
    expect(result.ok).toBe(false);
    expect(
      existsSync(join(dir, 'user-1', 'dot-1', 'thread-1', 'notes.md.br')),
    ).toBe(false);
  });

  it('applique le plafond disque en purgeant les sessions les plus anciennes', async () => {
    const dir = root();
    const store = new SessionBrainStore({
      rootDir: dir,
      diskLimitBytes: 2_500,
      maxSessionBytes: 5_000,
    });
    const a = { ...scope, threadId: 'disk-a' };
    const b = { ...scope, threadId: 'disk-b' };
    await store.write(a, randomBytes(1_500).toString('base64'));
    await store.write(b, randomBytes(1_500).toString('base64'));
    await store.flushNow();
    await store.sweepNow();
    expect(store.stats().diskBytes).toBeLessThanOrEqual(2_500);
  });

  it('ne casse pas sur un fichier corrompu', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = root();
    const sessionDir = join(dir, 'user-1', 'dot-1', 'thread-1');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'notes.md.br'), 'not brotli');
    const store = new SessionBrainStore({ rootDir: dir });
    expect(await store.read(scope)).toBe('');
  });

  it('purge immédiatement un compte, corbeille comprise', async () => {
    const dir = root();
    const store = new SessionBrainStore({ rootDir: dir });
    await store.append(scope, 'donnée compte');
    await store.deleteThread(scope);
    expect(existsSync(join(dir, 'user-1'))).toBe(true);
    expect(existsSync(join(dir, 'trash', 'user-1'))).toBe(true);
    await store.purgeUser('user-1');
    expect(existsSync(join(dir, 'user-1'))).toBe(false);
    expect(existsSync(join(dir, 'trash', 'user-1'))).toBe(false);
  });
});
