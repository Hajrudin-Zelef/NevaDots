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
  it('settings corrompu : défauts + mise de côté + warning, boot OK', () => {
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
    // Quarantaine présente, ligne d'origine intacte (restauration possible).
    const check = new DatabaseSync(path);
    const quarry = check
      .prepare('SELECT value FROM settings_quarantine WHERE id=1')
      .get() as { value: string };
    expect(quarry.value).toBe('!!!pas-du-json!!!');
    const kept = check
      .prepare('SELECT value FROM settings WHERE id=1')
      .get() as { value: string };
    expect(kept.value).toBe('!!!pas-du-json!!!');
    check.close();
    // Idempotent : rouvrir ne duplique ni n'écrase.
    const again = new Store(path);
    expect(again.settings()).toBeTruthy();
    again.close();
    reopened.close();
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
});
