import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store';
import { safeJsonParse } from '../src/server/safe-json';

describe('safeJsonParse', () => {
  it('parses valid JSON and returns the fallback on corrupt input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(safeJsonParse('{"a":1}', null, 'x')).toEqual({ a: 1 });
    expect(safeJsonParse('!!!', { fallback: true }, 'x')).toEqual({
      fallback: true,
    });
    expect(safeJsonParse(null, [], 'x')).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('corrupt database rows never crash the reader', () => {
  it('detail() ignores a corrupt runs.result', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'safe-json-')), 's.sqlite');
    const store = new Store(path).forUser('owner');
    const task = store.createTask('t');
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "INSERT INTO runs VALUES ('r1', ?, 'succeeded', 1, 2, '!!!not-json!!!', NULL, 'owner')",
      )
      .run(task.id);
    raw.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const detail = store.detail(task.id);
    expect(detail?.runs[0]?.result).toBeNull();
    warn.mockRestore();
    store.close();
  });
});
