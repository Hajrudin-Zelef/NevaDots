import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MAX_PROMPT_HISTORY,
  MAX_PROMPT_HISTORY_WITH_ATTACHMENTS,
  isCursorOnFirstLine,
  isCursorOnLastLine,
  loadPromptHistory,
  pushPromptHistory,
  removePromptHistoryEntry,
  type PromptHistoryEntry,
} from '../src/client/prompt-history';

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

const entry = (prompt: string, mode: 'chat' | 'home' = 'chat'): PromptHistoryEntry => ({
  prompt,
  mode,
});

it('push / load : la plus récente d’abord', () => {
  pushPromptHistory(entry('premier'));
  pushPromptHistory(entry('deuxième'));
  expect(loadPromptHistory().map((e) => e.prompt)).toEqual([
    'deuxième',
    'premier',
  ]);
});

it('déduplication exacte : même prompt remonté en tête, une seule entrée', () => {
  pushPromptHistory(entry('a'));
  pushPromptHistory(entry('b'));
  pushPromptHistory(entry('a'));
  expect(loadPromptHistory().map((e) => e.prompt)).toEqual(['a', 'b']);
  // Même prompt, autre mode = autre entrée.
  pushPromptHistory(entry('a', 'home'));
  expect(loadPromptHistory()).toHaveLength(3);
});

it('cap 200 entrées au total', () => {
  for (let i = 0; i < MAX_PROMPT_HISTORY + 10; i++) {
    pushPromptHistory(entry(`p${i}`));
  }
  const loaded = loadPromptHistory();
  expect(loaded).toHaveLength(MAX_PROMPT_HISTORY);
  expect(loaded[0].prompt).toBe(`p${MAX_PROMPT_HISTORY + 9}`);
  expect(loaded.at(-1)?.prompt).toBe('p10');
});

it('cap 100 entrées avec pièces jointes (les autres restent)', () => {
  for (let i = 0; i < MAX_PROMPT_HISTORY_WITH_ATTACHMENTS + 10; i++) {
    pushPromptHistory({ prompt: `avec-${i}`, mode: 'chat', attachments: ['f.txt'] });
  }
  for (let i = 0; i < 5; i++) pushPromptHistory(entry(`sans-${i}`));
  const loaded = loadPromptHistory();
  expect(loaded.filter((e) => e.attachments?.length).length).toBe(
    MAX_PROMPT_HISTORY_WITH_ATTACHMENTS,
  );
  expect(loaded.filter((e) => !e.attachments?.length)).toHaveLength(5);
  expect(loaded[0].prompt).toBe('sans-4');
});

it('retrait d’une entrée (échec du tour)', () => {
  pushPromptHistory(entry('ok'));
  const failed = entry('raté');
  pushPromptHistory(failed);
  removePromptHistoryEntry(failed);
  expect(loadPromptHistory().map((e) => e.prompt)).toEqual(['ok']);
});

it('curseur première / dernière ligne', () => {
  expect(isCursorOnFirstLine('a\nb', 0)).toBe(true);
  expect(isCursorOnFirstLine('a\nb', 1)).toBe(true);
  expect(isCursorOnFirstLine('a\nb', 2)).toBe(false);
  // Index 2 = début de la dernière ligne (« b ») : déjà dernière ligne.
  expect(isCursorOnLastLine('a\nb', 2)).toBe(true);
  expect(isCursorOnLastLine('a\nb', 3)).toBe(true);
  expect(isCursorOnLastLine('a\nb', 1)).toBe(false);
});
