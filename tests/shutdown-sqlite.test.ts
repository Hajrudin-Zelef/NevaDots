import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createShutdown } from '../src/server/shutdown.js';
import { Store } from '../src/server/store.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmpFile(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lot5-'));
  dirs.push(dir);
  return join(dir, name);
}

describe('createShutdown', () => {
  it('est idempotent : 2e appel = no-op, pas de double-close', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const shutdown = createShutdown({
      stopRunner: () => void calls.push('runner'),
      stopPlatform: async () => void calls.push('platform'),
      closeServer: async () => void calls.push('server'),
      closeStores: () => void calls.push('stores'),
      exit: (code) => void exits.push(code),
      report: () => {},
    });
    await shutdown();
    await shutdown();
    expect(calls).toEqual(['runner', 'platform', 'server', 'stores']);
    expect(exits).toEqual([0]);
  });

  it('rapporte un closeStores en échec sans crasher', async () => {
    const reported: string[] = [];
    const exits: number[] = [];
    const shutdown = createShutdown({
      stopRunner: () => {},
      stopPlatform: async () => {},
      closeServer: async () => {},
      closeStores: () => {
        throw new Error('verrou');
      },
      exit: (code) => void exits.push(code),
      report: (operation) => void reported.push(operation),
    });
    await shutdown();
    expect(reported).toEqual(['Closing stores failed']);
    expect(exits).toEqual([1]);
  });
});

describe('boot tolérant (quarantaine, jamais de suppression)', () => {
  it('settings corrompu : défauts + mise de côté append-only + warning, boot OK', () => {
    const path = tmpFile('store.sqlite');
    const seed = new Store(path);
    expect(seed.settings()).toBeTruthy();
    seed.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare("UPDATE settings SET value='!!!pas-du-json!!!' WHERE id=1")
      .run();
    raw.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reopened = new Store(path);
    expect(reopened.settings()).toEqual(
      expect.objectContaining({ researchAllowed: expect.anything() }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('settings_quarantine'),
    );
    const check = new DatabaseSync(path);
    // Original preserved for manual restoration.
    const quarry = check
      .prepare('SELECT value FROM settings_quarantine ORDER BY id DESC LIMIT 1')
      .get() as { value: string };
    expect(quarry.value).toBe('!!!pas-du-json!!!');
    // The settings row is reset to defaults so the warning does not repeat.
    const kept = check
      .prepare('SELECT value FROM settings WHERE id=1')
      .get() as { value: string };
    expect(() => JSON.parse(kept.value)).not.toThrow();
    check.close();
    // Idempotent: reopening neither re-quarantines nor duplicates.
    const again = new Store(path);
    expect(again.settings()).toBeTruthy();
    again.close();
    const recount = new DatabaseSync(path);
    const count = recount
      .prepare('SELECT COUNT(*) c FROM settings_quarantine')
      .get() as { c: number };
    expect(count.c).toBe(1);
    recount.close();
    reopened.close();
  });

  it('une seconde corruption ajoute une ligne, sans écraser la première', () => {
    const path = tmpFile('store2.sqlite');
    const seed = new Store(path);
    seed.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['!!!one!!!', '!!!two!!!']) {
      const raw = new DatabaseSync(path);
      raw.prepare('UPDATE settings SET value=? WHERE id=1').run(bad);
      raw.close();
      new Store(path).settings();
    }
    const check = new DatabaseSync(path);
    const rows = check
      .prepare('SELECT value FROM settings_quarantine ORDER BY id')
      .all() as { value: string }[];
    expect(rows.map((r) => r.value)).toEqual(['!!!one!!!', '!!!two!!!']);
    check.close();
    warn.mockRestore();
  });

  it('runner corrompu : lignes ignorées avec warning, boot OK, close idempotent', () => {
    const path = tmpFile('runner.sqlite');
    const seed = new SqliteAgentRunner(path);
    seed.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        'INSERT INTO runner_threads (thread_id, messages, created_at) VALUES (?, ?, ?)',
      )
      .run('t-corrupt', '!!!pas-du-json!!!', Date.now());
    raw
      .prepare(
        'INSERT INTO runner_runs (thread_id, run_id, agent_id, parent_run_id, events, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('t-corrupt', 'r1', null, null, '!!!pas-du-json!!!', Date.now());
    raw.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reopened = new SqliteAgentRunner(path);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('corrompue(s) ignorée(s)'),
    );
    // Lignes conservées (restauration manuelle possible).
    const check = new DatabaseSync(path);
    expect(
      (
        check.prepare('SELECT COUNT(*) c FROM runner_threads').get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    check.close();
    expect(() => reopened.close()).not.toThrow();
    expect(() => reopened.close()).not.toThrow();
  });

  it('close idempotent sur Store', () => {
    const path = tmpFile('close.sqlite');
    const store = new Store(path);
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it('migre une quarantaine legacy mono-ligne sans perdre la valeur', () => {
    const path = tmpFile('store3.sqlite');
    const seed = new Store(path);
    seed.close();
    const raw = new DatabaseSync(path);
    // Ancien schéma mono-ligne + une valeur déjà mise de côté.
    raw.exec('DROP TABLE IF EXISTS settings_quarantine');
    raw.exec(
      'CREATE TABLE settings_quarantine(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, quarantinedAt INTEGER NOT NULL)',
    );
    raw
      .prepare('INSERT INTO settings_quarantine VALUES (1, ?, ?)')
      .run('!!!legacy!!!', 1);
    raw.prepare("UPDATE settings SET value='!!!bad!!!' WHERE id=1").run();
    raw.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Store(path).settings();
    warn.mockRestore();
    const check = new DatabaseSync(path);
    const rows = check
      .prepare('SELECT value FROM settings_quarantine ORDER BY id')
      .all() as { value: string }[];
    // Legacy préservée, puis la nouvelle corruption ajoutée.
    expect(rows.map((r) => r.value)).toEqual(['!!!legacy!!!', '!!!bad!!!']);
    check.close();
  });
});
