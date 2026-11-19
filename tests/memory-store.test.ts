import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

const resources: { store: Store; dir: string }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-memory-'));
  const path = join(dir, 'test.sqlite');
  const store = new Store(path).forUser('owner');
  resources.push({ store, dir });
  return { store, path };
}
afterEach(() =>
  resources.splice(0).forEach(({ store, dir }) => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }),
);

describe('mémoire apprise', () => {
  it('enregistre une mémoire avec sa provenance', () => {
    const { store } = fixture();
    const memory = store.learnMemory({
      text: 'je m’appelle Sam',
      threadId: 'thread-1',
      messageId: 'message-1',
    });
    expect(memory).not.toBeNull();
    expect(memory?.text).toBe('je m’appelle Sam');
    expect(memory?.source).toBe('explicit');
    expect(memory?.origin).toBe('chat');
    expect(memory?.threadId).toBe('thread-1');
    expect(memory?.messageId).toBe('message-1');
    expect(store.memories()).toHaveLength(1);
  });

  it('ne duplique pas une formulation déjà connue', () => {
    const { store } = fixture();
    store.learnMemory({
      text: 'je m’appelle Sam',
      threadId: 't',
      messageId: 'm',
    });
    const duplicate = store.learnMemory({
      text: 'Je m appelle Sam',
      threadId: 't',
      messageId: 'm2',
    });
    expect(duplicate).toBeNull();
    expect(store.memories()).toHaveLength(1);
  });

  it('ignore un texte vide ou trop long', () => {
    const { store } = fixture();
    expect(store.learnMemory({ text: '   ' })).toBeNull();
    expect(store.learnMemory({ text: 'a'.repeat(501) })).toBeNull();
    expect(store.memories()).toHaveLength(0);
  });

  it('refuse au-delà du plafond sans supprimer', () => {
    const { store } = fixture();
    for (let index = 0; index < 200; index += 1)
      store.learnMemory({ text: `fait numéro ${index}` });
    expect(store.memories()).toHaveLength(200);
    expect(store.learnMemory({ text: 'fait de trop' })).toBeNull();
    expect(store.memories()).toHaveLength(200);
  });

  it('isole les mémoires par compte', () => {
    const { store, path } = fixture();
    store.learnMemory({ text: 'je m’appelle Sam' });
    const other = new Store(path).forUser('someone-else');
    expect(other.memories()).toHaveLength(0);
    other.close();
  });

  it('préserve la mémoire manuelle (Réglages)', () => {
    const { store } = fixture();
    const manual = store.saveMemory('Mon ton préféré est direct');
    expect(manual.source).toBe('manual');
    expect(manual.origin).toBe('settings');
    expect(store.memories()).toHaveLength(1);
  });
});
