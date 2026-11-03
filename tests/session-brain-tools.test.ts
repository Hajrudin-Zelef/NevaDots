import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionBrainStore,
  type SessionBrainScope,
} from '../src/server/session-brain.js';
import { sessionBrainTools } from '../src/server/session-brain-tools.js';

const roots: string[] = [];
const scope: SessionBrainScope = {
  userId: 'user-1',
  dotId: 'dot-1',
  threadId: 'thread-1',
};

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-brain-tools-'));
  roots.push(root);
  return new SessionBrainStore({ rootDir: root, ...options });
}

function tool(
  store: SessionBrainStore,
  name: string,
  check: () => void = () => {},
) {
  const found = sessionBrainTools(store, scope, check).find(
    (item) => item.name === name,
  );
  if (!found) throw new Error(`missing tool ${name}`);
  return found as unknown as {
    execute?: (input: Record<string, unknown>) => Promise<unknown>;
  };
}

afterEach(() => {
  roots
    .splice(0)
    .reverse()
    .forEach((dir) => rmSync(dir, { recursive: true }));
});

describe('session brain tools', () => {
  it('ajoute, lit et remplace les notes de la session', async () => {
    const store = fixture();
    const append = tool(store, 'session_brain_note');
    const read = tool(store, 'session_brain_read');
    const write = tool(store, 'session_brain_write');

    await expect(
      append.execute?.({ note: 'Décision A' }),
    ).resolves.toMatchObject({ ok: true });
    const first = (await read.execute?.({})) as { notes: string };
    expect(first.notes).toContain('Décision A');

    await expect(
      write.execute?.({ content: '# Notes\n\n- Décision B\n' }),
    ).resolves.toMatchObject({ ok: true });
    const second = (await read.execute?.({})) as { notes: string };
    expect(second.notes).toContain('Décision B');
    expect(second.notes).not.toContain('Décision A');
  });

  it('respecte le plafond de session et le check d’annulation', async () => {
    const store = fixture({ maxSessionBytes: 5 });
    const append = tool(store, 'session_brain_note');
    await expect(
      append.execute?.({ note: 'trop long' }),
    ).resolves.toMatchObject({ ok: false });

    const blocked = tool(store, 'session_brain_read', () => {
      throw new Error('aborted');
    });
    await expect(blocked.execute?.({})).rejects.toThrow('aborted');
  });

  it('isole les outils par thread', async () => {
    const store = fixture();
    await tool(store, 'session_brain_note').execute?.({ note: 'secret A' });
    expect(await store.read({ ...scope, threadId: 'thread-2' })).toBe('');
    expect(await store.read(scope)).toContain('secret A');
  });
});
