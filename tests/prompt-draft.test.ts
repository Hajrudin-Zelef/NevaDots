import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DRAFT_LRU_KEY,
  MAX_DRAFTS,
  clearDraft,
  draftKey,
  loadDraft,
  saveDraft,
} from '../src/client/prompt-draft';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('clés thread/home (même convention que les pièces jointes)', () => {
  expect(draftKey('thread:abc')).toBe('nevadots:draft:thread:abc');
  expect(draftKey('home:dot-1')).toBe('nevadots:draft:home:dot-1');
});

it('save / load / clear, par contexte', () => {
  saveDraft('thread:t1', 'bonjour');
  expect(loadDraft('thread:t1')).toBe('bonjour');
  expect(loadDraft('thread:t2')).toBe('');
  expect(loadDraft('home:d1')).toBe('');
  clearDraft('thread:t1');
  expect(loadDraft('thread:t1')).toBe('');
  expect(store.has(draftKey('thread:t1'))).toBe(false);
});

it('texte vide = suppression (pas de clé fantôme)', () => {
  saveDraft('thread:t1', 'x');
  saveDraft('thread:t1', '');
  expect(loadDraft('thread:t1')).toBe('');
  expect(store.has(draftKey('thread:t1'))).toBe(false);
});

it('cap LRU 20 : le plus ancien brouillon est évincé', () => {
  for (let i = 0; i < MAX_DRAFTS + 1; i++) {
    saveDraft(`thread:t${i}`, `brouillon ${i}`);
  }
  expect(loadDraft('thread:t0')).toBe('');
  expect(loadDraft('thread:t1')).toBe('brouillon 1');
  expect(loadDraft(`thread:t${MAX_DRAFTS}`)).toBe(`brouillon ${MAX_DRAFTS}`);
  const lru: unknown = JSON.parse(store.get(DRAFT_LRU_KEY) ?? '[]');
  expect(Array.isArray(lru) && lru.length).toBe(MAX_DRAFTS);
});

it('réutiliser un brouillon le remet en tête de file LRU', () => {
  for (let i = 0; i < MAX_DRAFTS; i++) saveDraft(`thread:t${i}`, `v${i}`);
  saveDraft('thread:t0', 'v0 à nouveau');
  saveDraft('thread:tn', 'nouveau');
  // t0 survit (retouché), t1 est évincé à la place.
  expect(loadDraft('thread:t0')).toBe('v0 à nouveau');
  expect(loadDraft('thread:t1')).toBe('');
  expect(loadDraft('thread:tn')).toBe('nouveau');
});
