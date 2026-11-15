import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

{
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  });
}

import {
  conversationHash,
  EMPTY_TABS_STATE,
  isRestoreClosedTabKey,
  MAX_CLOSED_TABS,
  nextTabAfterClose,
  parseClosedTabs,
  parseConversationHash,
  parseTabs,
  tabsReducer,
  useTabs,
  TABS_CLOSED_KEY,
  TABS_RECENT_KEY,
  TABS_STORAGE_KEY,
  type TabsStoreState,
  type UseTabs,
} from '../src/client/useTabs';

// ---------------------------------------------------------------------------
// Helpers purs
// ---------------------------------------------------------------------------

it('parseTabs : rejette les entrées invalides et déduplique', () => {
  expect(
    parseTabs([
      { threadId: 'a' },
      { threadId: '' },
      { threadId: 'a', draftId: 'd1' },
      { threadId: 'b', draftId: 'd2' },
      { threadId: 3 },
      null,
      'c',
    ]),
  ).toEqual([{ threadId: 'a' }, { threadId: 'b', draftId: 'd2' }]);
  expect(parseTabs('nope')).toEqual([]);
  expect(parseTabs(undefined)).toEqual([]);
});

it('parseClosedTabs : capé aux 100 plus récents', () => {
  const pile = Array.from({ length: 150 }, (_, i) => ({
    tab: { threadId: `t${i}` },
    index: i,
  }));
  const parsed = parseClosedTabs(pile);
  expect(parsed).toHaveLength(MAX_CLOSED_TABS);
  expect(parsed[0].tab.threadId).toBe('t50');
  expect(parsed[99].tab.threadId).toBe('t149');
  expect(
    parseClosedTabs([{ tab: { threadId: 'a' }, index: -2 }])[0].index,
  ).toBe(0);
});

it('nextTabAfterClose : le suivant, sinon le précédent, sinon rien', () => {
  // `tabs` = liste APRÈS suppression, `index` = place de l'onglet fermé.
  expect(nextTabAfterClose([{ threadId: 'b' }, { threadId: 'c' }], 0)).toEqual({
    threadId: 'b',
  });
  expect(nextTabAfterClose([{ threadId: 'a' }, { threadId: 'c' }], 1)).toEqual({
    threadId: 'c',
  });
  expect(nextTabAfterClose([{ threadId: 'a' }, { threadId: 'b' }], 2)).toEqual({
    threadId: 'b',
  });
  expect(nextTabAfterClose([], 0)).toBeUndefined();
});

it('hash conversation : aller-retour, et rejet des autres routes', () => {
  expect(conversationHash('abc 123')).toBe('#/conversations/abc%20123');
  expect(parseConversationHash('#/conversations/abc%20123')).toBe('abc 123');
  expect(parseConversationHash('#/conversations/')).toBeUndefined();
  expect(parseConversationHash('#/spaces/s1')).toBeUndefined();
  expect(parseConversationHash('#/conversations/a/pages/b')).toBeUndefined();
  expect(parseConversationHash('')).toBeUndefined();
  expect(parseConversationHash('#/conversations/%E0%A4%A')).toBeUndefined();
});

it('isRestoreClosedTabKey : mod+shift+t seulement', () => {
  const base = { key: 'T', ctrlKey: false, metaKey: false, shiftKey: false };
  expect(
    isRestoreClosedTabKey({ ...base, ctrlKey: true, shiftKey: true }),
  ).toBe(true);
  expect(
    isRestoreClosedTabKey({ ...base, metaKey: true, shiftKey: true }),
  ).toBe(true);
  expect(isRestoreClosedTabKey({ ...base, ctrlKey: true })).toBe(false);
  expect(isRestoreClosedTabKey({ ...base, shiftKey: true })).toBe(false);
  expect(
    isRestoreClosedTabKey({ ...base, ctrlKey: true, shiftKey: true, key: 'w' }),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Réducteur
// ---------------------------------------------------------------------------

const stateWith = (ids: string[], active?: string): TabsStoreState => ({
  ...EMPTY_TABS_STATE,
  tabs: ids.map((threadId) => ({ threadId })),
  activeThreadId: active,
});

it('open : ajoute et active ; rouvrir active sans dupliquer', () => {
  let state = tabsReducer(EMPTY_TABS_STATE, { type: 'open', threadId: 'a' });
  expect(state.tabs).toEqual([{ threadId: 'a' }]);
  expect(state.activeThreadId).toBe('a');
  state = tabsReducer(state, { type: 'open', threadId: 'b' });
  state = tabsReducer(state, { type: 'open', threadId: 'a' });
  expect(state.tabs).toEqual([{ threadId: 'a' }, { threadId: 'b' }]);
  expect(state.activeThreadId).toBe('a');
});

it('open en arrière-plan : ajoute sans naviguer, ne remplace pas l’aperçu', () => {
  const state = tabsReducer(stateWith(['a'], 'a'), {
    type: 'open',
    threadId: 'b',
    background: true,
  });
  expect(state.tabs).toEqual([{ threadId: 'a' }, { threadId: 'b' }]);
  expect(state.activeThreadId).toBe('a');
  // L'aperçu actif survit à une ouverture en arrière-plan.
  const withPreview = tabsReducer(EMPTY_TABS_STATE, {
    type: 'open',
    threadId: 'p',
    preview: true,
  });
  const kept = tabsReducer(withPreview, {
    type: 'open',
    threadId: 'q',
    background: true,
  });
  expect(kept.tabs).toEqual([{ threadId: 'p' }, { threadId: 'q' }]);
  expect(kept.activeThreadId).toBe('p');
  expect(kept.previewThreadId).toBe('p');
});

it('aperçu : remplacé par la prochaine ouverture, conservé par keepPreview', () => {
  let state = tabsReducer(EMPTY_TABS_STATE, {
    type: 'open',
    threadId: 'a',
    preview: true,
  });
  expect(state.previewThreadId).toBe('a');
  state = tabsReducer(state, { type: 'open', threadId: 'b' });
  expect(state.tabs).toEqual([{ threadId: 'b' }]);
  expect(state.previewThreadId).toBeUndefined();
  expect(state.activeThreadId).toBe('b');
  state = tabsReducer(state, { type: 'open', threadId: 'c', preview: true });
  expect(state.tabs).toEqual([{ threadId: 'b' }, { threadId: 'c' }]);
  state = tabsReducer(state, { type: 'keep-preview', threadId: 'c' });
  expect(state.previewThreadId).toBeUndefined();
  state = tabsReducer(state, { type: 'open', threadId: 'd' });
  expect(state.tabs).toEqual([
    { threadId: 'b' },
    { threadId: 'c' },
    { threadId: 'd' },
  ]);
});

it('fermeture : pile des fermés, actif = suivant sinon précédent, aperçu non empilé', () => {
  let state = stateWith(['a', 'b', 'c'], 'b');
  state = tabsReducer(state, { type: 'close', threadId: 'b', title: 'B' });
  expect(state.tabs).toEqual([{ threadId: 'a' }, { threadId: 'c' }]);
  expect(state.activeThreadId).toBe('c');
  expect(state.closed).toEqual([
    { tab: { threadId: 'b' }, index: 1, title: 'B' },
  ]);
  state = tabsReducer(state, { type: 'close', threadId: 'c' });
  expect(state.activeThreadId).toBe('a');
  // Fermer l'aperçu ne l'empile pas (état provisoire détruit).
  state = tabsReducer(state, { type: 'open', threadId: 'p', preview: true });
  state = tabsReducer(state, { type: 'close', threadId: 'p' });
  expect(state.closed).toHaveLength(2);
  expect(state.tabs).toEqual([{ threadId: 'a' }]);
});

it('restore : réinsère à l’index d’origine et active', () => {
  let state = stateWith(['a', 'b', 'c'], 'b');
  state = tabsReducer(state, { type: 'close', threadId: 'b' });
  state = tabsReducer(state, { type: 'close', threadId: 'a' });
  expect(state.tabs).toEqual([{ threadId: 'c' }]);
  state = tabsReducer(state, { type: 'restore' });
  expect(state.tabs).toEqual([{ threadId: 'a' }, { threadId: 'c' }]);
  expect(state.activeThreadId).toBe('a');
  state = tabsReducer(state, { type: 'restore' });
  expect(state.tabs).toEqual([
    { threadId: 'a' },
    { threadId: 'b' },
    { threadId: 'c' },
  ]);
  expect(state.activeThreadId).toBe('b');
  expect(state.closed).toEqual([]);
  // Pile vide : no-op.
  expect(tabsReducer(state, { type: 'restore' })).toBe(state);
});

it('close-all et deactivate ne touchent pas à la pile des fermés', () => {
  let state = stateWith(['a', 'b'], 'a');
  state = tabsReducer(state, { type: 'close', threadId: 'a' });
  expect(state.closed).toHaveLength(1);
  state = tabsReducer(state, { type: 'deactivate' });
  expect(state.activeThreadId).toBeUndefined();
  expect(state.tabs).toEqual([{ threadId: 'b' }]);
  state = tabsReducer(state, { type: 'close-all' });
  expect(state.tabs).toEqual([]);
  expect(state.activeThreadId).toBeUndefined();
  expect(state.closed).toHaveLength(1);
});

it('prune : élague les disparus, répare l’actif et l’aperçu', () => {
  // Actif supprimé avec plusieurs onglets avant lui : le survivant suivant.
  let state = stateWith(['a', 'b', 'c', 'd'], 'b');
  state = tabsReducer(state, {
    type: 'prune',
    validIds: new Set(['a', 'c', 'd']),
  });
  expect(state.tabs).toEqual([
    { threadId: 'a' },
    { threadId: 'c' },
    { threadId: 'd' },
  ]);
  expect(state.activeThreadId).toBe('c');
  // Actif = dernier survivant supprimé : le précédent.
  state = stateWith(['a', 'b', 'c', 'd'], 'd');
  state = tabsReducer(state, {
    type: 'prune',
    validIds: new Set(['a', 'c']),
  });
  expect(state.activeThreadId).toBe('c');
  // Rien ne change : même objet (pas de re-rendu inutile au polling 3 s).
  const kept = stateWith(['a', 'b'], 'a');
  expect(
    tabsReducer(kept, { type: 'prune', validIds: new Set(['a', 'b']) }),
  ).toBe(kept);
  // La pile des fermés est élaguée elle aussi.
  state = stateWith(['a', 'b'], 'a');
  state = tabsReducer(state, { type: 'close', threadId: 'b' });
  state = tabsReducer(state, {
    type: 'prune',
    validIds: new Set(['a']),
  });
  expect(state.closed).toEqual([]);
});

// ---------------------------------------------------------------------------
// Hook (persistance + resynchronisation)
// ---------------------------------------------------------------------------

let latest: UseTabs | null = null;

function Probe({
  validThreadIds,
  initialActiveThreadId,
}: {
  validThreadIds?: string[];
  initialActiveThreadId?: string;
}) {
  const tabs = useTabs({ validThreadIds, initialActiveThreadId });
  latest = tabs;
  return null;
}

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
});
beforeEach(() => {
  latest = null;
  (localStorage as Storage).clear();
});

async function mount(
  props: {
    validThreadIds?: string[];
    initialActiveThreadId?: string;
  } = {},
) {
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Probe, props));
    roots.push(root!);
  });
  await act(async () => {});
  return latest!;
}

async function update(
  root: ReturnType<typeof create>,
  props: {
    validThreadIds?: string[];
    initialActiveThreadId?: string;
  },
) {
  await act(async () => {
    root.update(createElement(Probe, props));
  });
  await act(async () => {});
}

it('persiste onglets + récent + fermés, et restaure après remontage', async () => {
  const tabs = await mount({ validThreadIds: ['a', 'b', 'c'] });
  await act(async () => {
    tabs.openTab('a');
    tabs.openTab('b');
  });
  await act(async () => {
    tabs.closeTab('a');
  });
  expect(JSON.parse(localStorage.getItem(TABS_STORAGE_KEY)!)).toEqual([
    { threadId: 'b' },
  ]);
  expect(localStorage.getItem(TABS_RECENT_KEY)).toBe('"b"');
  expect(JSON.parse(localStorage.getItem(TABS_CLOSED_KEY)!)).toEqual([
    { tab: { threadId: 'a' }, index: 0 },
  ]);
  // Rechargement : l'onglet actif est restauré, la pile survit.
  const reloaded = await mount({ validThreadIds: ['a', 'b', 'c'] });
  expect(reloaded.tabs).toEqual([{ threadId: 'b' }]);
  expect(reloaded.activeThreadId).toBe('b');
  expect(reloaded.hasClosedTabs).toBe(true);
  await act(async () => {
    reloaded.restoreClosedTab();
  });
  // `reloaded` est l'objet du rendu du montage : relire `latest` après l'act.
  expect(latest!.tabs).toEqual([{ threadId: 'a' }, { threadId: 'b' }]);
  expect(latest!.activeThreadId).toBe('a');
});

it('deep-link : la route en hash ouvre l’onglet au chargement', async () => {
  (localStorage as Storage).setItem(
    TABS_STORAGE_KEY,
    JSON.stringify([{ threadId: 'a' }]),
  );
  (localStorage as Storage).setItem(TABS_RECENT_KEY, JSON.stringify('a'));
  const tabs = await mount({
    validThreadIds: ['a', 'b'],
    initialActiveThreadId: 'b',
  });
  expect(tabs.tabs).toEqual([{ threadId: 'a' }, { threadId: 'b' }]);
  expect(tabs.activeThreadId).toBe('b');
});

it('resynchronise avec le refresh() : un onglet supprimé se ferme', async () => {
  const tabs = await mount({ validThreadIds: ['a', 'b', 'c'] });
  const mounted = roots[roots.length - 1];
  await act(async () => {
    tabs.openTab('a');
    tabs.openTab('b');
    tabs.openTab('c');
  });
  expect(latest!.activeThreadId).toBe('c');
  // Le polling renvoie la liste sans 'b' ni 'c' : 'c' (actif) se ferme,
  // l'actif devient le survivant précédent ('a').
  await update(mounted, { validThreadIds: ['a'] });
  expect(latest!.tabs).toEqual([{ threadId: 'a' }]);
  expect(latest!.activeThreadId).toBe('a');
});

it('aucun élagage tant que le workspace n’est pas chargé', async () => {
  (localStorage as Storage).setItem(
    TABS_STORAGE_KEY,
    JSON.stringify([{ threadId: 'a' }, { threadId: 'b' }]),
  );
  (localStorage as Storage).setItem(TABS_RECENT_KEY, JSON.stringify('b'));
  const tabs = await mount({});
  expect(tabs.tabs).toEqual([{ threadId: 'a' }, { threadId: 'b' }]);
  expect(tabs.activeThreadId).toBe('b');
});
