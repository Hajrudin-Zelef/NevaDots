import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingAttachments,
  loadPendingAttachments,
  PENDING_TEXT_CACHE_LIMIT,
  savePendingAttachments,
  type Attachment,
} from '../src/client/attachments';

/** Stub localStorage en mémoire (vitest tourne en environnement node). */
function installMemoryStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
  return store;
}

const ready = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: '11111111-2222-3333-4444-555555555555',
  name: 'notes.txt',
  size: 42,
  mime: 'text/plain',
  category: 'text',
  status: 'ready',
  ...overrides,
});

describe('persistance localStorage des pièces jointes (phase 2a)', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it('roundtrip : sauvegarde puis relecture', () => {
    savePendingAttachments('thread:abc', [ready()]);
    const loaded = loadPendingAttachments('thread:abc');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('11111111-2222-3333-4444-555555555555');
    expect(loaded[0].name).toBe('notes.txt');
  });

  it('isole les contextes (scopes)', () => {
    savePendingAttachments('thread:abc', [ready()]);
    expect(loadPendingAttachments('thread:xyz')).toEqual([]);
    expect(loadPendingAttachments('home:dot1')).toEqual([]);
  });

  it('ne persiste que les fichiers prêts (pas uploading / error / local-)', () => {
    savePendingAttachments('thread:abc', [
      ready(),
      ready({
        id: 'local-123',
        name: 'tmp.txt',
        status: 'uploading',
      }),
      ready({
        id: '22222222-2222-3333-4444-555555555555',
        name: 'ko.txt',
        status: 'error',
      }),
    ]);
    const loaded = loadPendingAttachments('thread:abc');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('ne persiste le textContent que sous le seuil', () => {
    const small = 'x'.repeat(100);
    const big = 'y'.repeat(PENDING_TEXT_CACHE_LIMIT + 1);
    savePendingAttachments('thread:abc', [
      ready({ textContent: small }),
      ready({
        id: '22222222-2222-3333-4444-555555555555',
        name: 'big.txt',
        textContent: big,
      }),
    ]);
    const loaded = loadPendingAttachments('thread:abc');
    expect(loaded).toHaveLength(2);
    expect(loaded[0].textContent).toBe(small);
    expect(loaded[1].textContent).toBeUndefined();
  });

  it('JSON corrompu → liste vide, sans exception', () => {
    localStorage.setItem('nevadots:attachments:thread:abc', 'pas-du-json{{{');
    expect(loadPendingAttachments('thread:abc')).toEqual([]);
  });

  it('clearPendingAttachments vide le brouillon', () => {
    savePendingAttachments('thread:abc', [ready()]);
    clearPendingAttachments('thread:abc');
    expect(loadPendingAttachments('thread:abc')).toEqual([]);
  });

  it('sans localStorage (SSR) → no-op silencieux', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => savePendingAttachments('thread:abc', [ready()])).not.toThrow();
    expect(loadPendingAttachments('thread:abc')).toEqual([]);
    expect(() => clearPendingAttachments('thread:abc')).not.toThrow();
  });
});
