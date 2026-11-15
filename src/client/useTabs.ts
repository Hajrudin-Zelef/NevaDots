import { useEffect, useReducer } from 'react';

// Store d'onglets persistés (Lot 1 du portage visuel OpenCode).
//
// Inspiration libre (valeurs et principes OpenCode, domaine 2 §5) :
// onglets { threadId, draftId? } + recentKey + pile des fermés (limite 100,
// restauration à l'index d'origine) + onglet aperçu éphémère. Réimplémenté
// en React avec nos propres noms et notre propre structure — aucun code
// OpenCode repris.
//
// État du strip visuel (revue finale, Important 5 — trou du PLAN, pas un
// oubli d'implémentation) : AUCUN composant ne rend de bande d'onglets.
// En attendant un lot dédié « bande d'onglets » (décision utilisateur),
// `closeTab` n'est appelé que par la suppression (avec `keepClosed: false`,
// donc rien n'entre jamais dans la pile des fermés) et `closeAllTabs` que
// par « tout supprimer » — `mod+shift+t` (`restoreClosedTab`) ne peut donc
// rien restaurer en pratique. Ne pas brancher de strip ici : c'est un
// nouveau lot, pas un correctif. La liste `tabs`, elle, est capée à 64
// (même politique que la liste des sessions) pour borner le `localStorage`.
//
// Resynchronisation : `refresh()` (polling 3 s dans App.tsx) écrase
// `workspace` ; le hook reçoit la liste courante des conversations et
// élague les onglets dont la conversation a disparu — jamais l'inverse
// (le store ne refait aucun fetch et n'écrit jamais dans `workspace`).

export interface Tab {
  threadId: string;
  draftId?: string;
}

export interface ClosedTab {
  tab: Tab;
  /** Index d'origine dans la liste, pour restaurer à la même place. */
  index: number;
  title?: string;
}

export interface TabsStoreState {
  tabs: Tab[];
  activeThreadId?: string;
  /** Onglet provisoire (un seul à la fois) : remplacé par la prochaine
   * ouverture, conservé définitivement par `keepPreview`. Non persisté. */
  previewThreadId?: string;
  closed: ClosedTab[];
}

export const MAX_CLOSED_TABS = 100;

/** Cap de la liste des onglets (même politique que les 64 sessions
 *  affichées) : borne le `localStorage`, comme la pile des fermés. */
export const MAX_TABS = 64;

export const TABS_STORAGE_KEY = 'nevadots-tabs';
export const TABS_RECENT_KEY = 'nevadots-tabs-recent';
export const TABS_CLOSED_KEY = 'nevadots-tabs-closed';

export type TabsAction =
  | {
      type: 'open';
      threadId: string;
      draftId?: string;
      /** Ouverture provisoire (clic depuis la liste) ou définitive. */
      preview?: boolean;
      /** Ouvrir sans naviguer (Cmd/Ctrl+Clic) : l'onglet actif ne change pas. */
      background?: boolean;
    }
  | { type: 'close'; threadId: string; keepClosed?: boolean; title?: string }
  | { type: 'restore' }
  | { type: 'keep-preview'; threadId: string }
  | { type: 'deactivate' }
  | { type: 'close-all' }
  | { type: 'prune'; validIds: Set<string> };

export const EMPTY_TABS_STATE: TabsStoreState = {
  tabs: [],
  activeThreadId: undefined,
  previewThreadId: undefined,
  closed: [],
};

// ---------------------------------------------------------------------------
// Lecture / écriture `localStorage` (tolérante : fenêtres privées, quota).
// ---------------------------------------------------------------------------

function readStored<T>(
  key: string,
  parse: (value: unknown) => T,
): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    return parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Appliqué pour cette visite seulement.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTab(value: unknown): Tab | undefined {
  if (!isRecord(value) || typeof value.threadId !== 'string' || !value.threadId)
    return undefined;
  const tab: Tab = { threadId: value.threadId };
  if (typeof value.draftId === 'string' && value.draftId)
    tab.draftId = value.draftId;
  return tab;
}

/** Valide et déduplique (premier gagnant) la liste persistée ; capée
 *  aux 64 plus récents (voir `MAX_TABS`). */
export function parseTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const item of value) {
    const tab = parseTab(item);
    if (tab && !seen.has(tab.threadId)) {
      seen.add(tab.threadId);
      tabs.push(tab);
    }
  }
  return tabs.slice(-MAX_TABS);
}

/** Valide la pile des fermés ; capée aux 100 plus récents. */
export function parseClosedTabs(value: unknown): ClosedTab[] {
  if (!Array.isArray(value)) return [];
  const closed: ClosedTab[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const tab = parseTab(item.tab);
    if (!tab) continue;
    const index =
      typeof item.index === 'number' && Number.isFinite(item.index)
        ? Math.max(0, Math.floor(item.index))
        : 0;
    const entry: ClosedTab = { tab, index };
    if (typeof item.title === 'string' && item.title) entry.title = item.title;
    closed.push(entry);
  }
  return closed.slice(-MAX_CLOSED_TABS);
}

/** Après fermeture de l'onglet d'index `index` : le suivant, sinon le précédent. */
export function nextTabAfterClose(tabs: Tab[], index: number): Tab | undefined {
  return tabs[index] ?? tabs[index - 1];
}

export function loadTabsState(initialActiveThreadId?: string): TabsStoreState {
  const tabs = readStored(TABS_STORAGE_KEY, parseTabs) ?? [];
  const closed = readStored(TABS_CLOSED_KEY, parseClosedTabs) ?? [];
  const recent = readStored(TABS_RECENT_KEY, (value) =>
    typeof value === 'string' ? value : undefined,
  );
  let activeThreadId: string | undefined;
  if (initialActiveThreadId) {
    // Deep-link `#/conversations/:id` : l'onglet est créé s'il n'existe pas
    // encore ; l'élagage le retirera au premier `refresh()` si l'id est inconnu.
    if (!tabs.some((tab) => tab.threadId === initialActiveThreadId))
      tabs.push({ threadId: initialActiveThreadId });
    activeThreadId = initialActiveThreadId;
  } else if (recent === '') {
    // Page vierge explicite au dernier départ : on y reste.
    activeThreadId = undefined;
  } else if (recent && tabs.some((tab) => tab.threadId === recent)) {
    activeThreadId = recent;
  } else {
    activeThreadId = tabs[0]?.threadId;
  }
  return {
    tabs: capTabs(tabs, activeThreadId),
    activeThreadId,
    previewThreadId: undefined,
    closed,
  };
}

// ---------------------------------------------------------------------------
// Réducteur pur (toute la logique d'onglets, testable sans React).
// ---------------------------------------------------------------------------

function insertAt<T>(list: T[], index: number, item: T): T[] {
  const next = [...list];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  return next;
}

/** Cap de la liste : retire les plus anciens, jamais l'onglet actif
 *  (ni celui qui vient d'être ouvert/restauré, qui est l'actif). */
function capTabs(tabs: Tab[], activeThreadId?: string): Tab[] {
  if (tabs.length <= MAX_TABS) return tabs;
  const overflow = tabs.length - MAX_TABS;
  let removed = 0;
  return tabs.filter((tab) => {
    if (removed < overflow && tab.threadId !== activeThreadId) {
      removed++;
      return false;
    }
    return true;
  });
}

export function tabsReducer(
  state: TabsStoreState,
  action: TabsAction,
): TabsStoreState {
  switch (action.type) {
    case 'open': {
      const { threadId, draftId, preview = false, background = false } = action;
      if (!threadId) return state;
      const existingIndex = state.tabs.findIndex(
        (tab) => tab.threadId === threadId,
      );
      if (existingIndex >= 0) {
        // Déjà ouvert : on l'active (sauf ouverture en arrière-plan), et un
        // brouillon éventuel est rattaché à l'onglet.
        const tabs =
          draftId && state.tabs[existingIndex].draftId !== draftId
            ? state.tabs.map((tab, i) =>
                i === existingIndex ? { ...tab, draftId } : tab,
              )
            : state.tabs;
        return {
          ...state,
          tabs,
          activeThreadId: background ? state.activeThreadId : threadId,
        };
      }
      const tab: Tab = draftId ? { threadId, draftId } : { threadId };
      let tabs: Tab[];
      let previewThreadId = state.previewThreadId;
      if (
        state.previewThreadId &&
        state.previewThreadId !== threadId &&
        !background
      ) {
        // L'aperçu provisoire est remplacé sur place par le nouvel onglet.
        // Une ouverture en arrière-plan ne le remplace pas : l'aperçu
        // (souvent l'onglet actif) doit rester navigable.
        const previewIndex = state.tabs.findIndex(
          (item) => item.threadId === state.previewThreadId,
        );
        tabs =
          previewIndex >= 0
            ? state.tabs.map((item, i) => (i === previewIndex ? tab : item))
            : [...state.tabs, tab];
        previewThreadId = undefined;
      } else {
        tabs = [...state.tabs, tab];
      }
      if (preview) previewThreadId = threadId;
      const activeThreadId = background ? state.activeThreadId : threadId;
      return {
        ...state,
        tabs: capTabs(tabs, activeThreadId),
        previewThreadId,
        activeThreadId,
      };
    }
    case 'close': {
      const index = state.tabs.findIndex(
        (tab) => tab.threadId === action.threadId,
      );
      if (index < 0) return state;
      const tab = state.tabs[index];
      const tabs = state.tabs.filter((_, i) => i !== index);
      const isPreview = state.previewThreadId === action.threadId;
      // Un aperçu (ou un brouillon fermé) ne va pas dans la pile : il n'y a
      // rien à restaurer, son état provisoire est détruit.
      const closed =
        action.keepClosed !== false && !isPreview
          ? [
              ...state.closed,
              {
                tab,
                index,
                ...(action.title ? { title: action.title } : {}),
              },
            ].slice(-MAX_CLOSED_TABS)
          : state.closed;
      return {
        ...state,
        tabs,
        closed,
        previewThreadId: isPreview ? undefined : state.previewThreadId,
        activeThreadId:
          state.activeThreadId === action.threadId
            ? nextTabAfterClose(tabs, index)?.threadId
            : state.activeThreadId,
      };
    }
    case 'restore': {
      const entry = state.closed[state.closed.length - 1];
      if (!entry) return state;
      const closed = state.closed.slice(0, -1);
      const alreadyOpen = state.tabs.some(
        (tab) => tab.threadId === entry.tab.threadId,
      );
      return {
        ...state,
        closed,
        tabs: alreadyOpen
          ? state.tabs
          : capTabs(
              insertAt(state.tabs, entry.index, entry.tab),
              entry.tab.threadId,
            ),
        activeThreadId: entry.tab.threadId,
      };
    }
    case 'keep-preview': {
      if (state.previewThreadId !== action.threadId) return state;
      return { ...state, previewThreadId: undefined };
    }
    case 'deactivate': {
      if (state.activeThreadId === undefined) return state;
      return { ...state, activeThreadId: undefined };
    }
    case 'close-all': {
      if (state.tabs.length === 0 && state.activeThreadId === undefined)
        return state;
      return {
        ...state,
        tabs: [],
        activeThreadId: undefined,
        previewThreadId: undefined,
      };
    }
    case 'prune': {
      const tabs = state.tabs.filter((tab) =>
        action.validIds.has(tab.threadId),
      );
      const closed = state.closed.filter((entry) =>
        action.validIds.has(entry.tab.threadId),
      );
      if (
        tabs.length === state.tabs.length &&
        closed.length === state.closed.length &&
        (state.activeThreadId === undefined ||
          action.validIds.has(state.activeThreadId)) &&
        (state.previewThreadId === undefined ||
          action.validIds.has(state.previewThreadId))
      )
        return state;
      let activeThreadId = state.activeThreadId;
      if (
        activeThreadId !== undefined &&
        !action.validIds.has(activeThreadId)
      ) {
        // L'onglet actif a disparu : le premier survivant après lui dans
        // l'ordre d'origine, sinon le dernier survivant avant lui (même
        // règle qu'à la fermeture, mais robuste à plusieurs suppressions).
        const index = state.tabs.findIndex(
          (tab) => tab.threadId === activeThreadId,
        );
        const after = state.tabs
          .slice(index + 1)
          .find((tab) => action.validIds.has(tab.threadId));
        const before = [...state.tabs.slice(0, index)]
          .reverse()
          .find((tab) => action.validIds.has(tab.threadId));
        activeThreadId = after?.threadId ?? before?.threadId;
      }
      return {
        ...state,
        tabs,
        closed,
        activeThreadId,
        previewThreadId:
          state.previewThreadId !== undefined &&
          action.validIds.has(state.previewThreadId)
            ? state.previewThreadId
            : undefined,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Routes conversation en hash (cohabitent avec `#/spaces/...`).
// ---------------------------------------------------------------------------

export function conversationHash(threadId: string): string {
  return `#/conversations/${encodeURIComponent(threadId)}`;
}

export function parseConversationHash(hash: string): string | undefined {
  const match = hash.match(/^#\/conversations\/([^/]+)$/);
  if (!match) return undefined;
  try {
    const id = decodeURIComponent(match[1]);
    return id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `mod+shift+t` : rouvrir le dernier onglet fermé. */
export function isRestoreClosedTabKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === 't'
  );
}

// ---------------------------------------------------------------------------
// Hook.
// ---------------------------------------------------------------------------

export interface UseTabsOptions {
  /** Ids des conversations existantes (`workspace.conversations`).
   * `undefined` tant que le workspace n'est pas chargé : aucun élagage. */
  validThreadIds?: string[];
  /** Conversation demandée par l'URL au chargement (`#/conversations/:id`). */
  initialActiveThreadId?: string;
}

export interface UseTabs {
  tabs: Tab[];
  activeThreadId?: string;
  previewThreadId?: string;
  closed: ClosedTab[];
  hasClosedTabs: boolean;
  openTab: (
    threadId: string,
    options?: { draftId?: string; preview?: boolean; background?: boolean },
  ) => void;
  closeTab: (
    threadId: string,
    options?: { keepClosed?: boolean; title?: string },
  ) => void;
  restoreClosedTab: () => void;
  keepPreview: (threadId: string) => void;
  deactivate: () => void;
  closeAllTabs: () => void;
}

export function useTabs({
  validThreadIds,
  initialActiveThreadId,
}: UseTabsOptions = {}): UseTabs {
  const [state, dispatch] = useReducer(
    tabsReducer,
    initialActiveThreadId,
    loadTabsState,
  );

  // Persistance : un effet par clé, écriture seulement quand elle change.
  useEffect(() => {
    writeStored(TABS_STORAGE_KEY, state.tabs);
  }, [state.tabs]);
  useEffect(() => {
    writeStored(TABS_RECENT_KEY, state.activeThreadId ?? '');
  }, [state.activeThreadId]);
  useEffect(() => {
    writeStored(TABS_CLOSED_KEY, state.closed);
  }, [state.closed]);

  // Resynchronisation avec le polling : `validThreadIds` change à chaque
  // `refresh()` (nouveau tableau) ; la clé jointe ne change que si le
  // contenu change, et le réducteur ne fait rien si rien n'a disparu.
  // `null` (non chargé) ≠ `''` (chargé vide) : sinon l'effet ne se
  // relancerait jamais quand le workspace charge avec zéro conversation,
  // et les onglets persistés obsolètes survivraient indéfiniment.
  const validKey =
    validThreadIds === undefined ? null : validThreadIds.join('\n');
  useEffect(() => {
    if (!validThreadIds) return;
    dispatch({ type: 'prune', validIds: new Set(validThreadIds) });
    // Dépendance volontairement réduite à la clé : le tableau est reconstruit
    // à chaque rendu d'App, son contenu seul compte.
  }, [validKey]);

  return {
    tabs: state.tabs,
    activeThreadId: state.activeThreadId,
    previewThreadId: state.previewThreadId,
    closed: state.closed,
    hasClosedTabs: state.closed.length > 0,
    openTab: (threadId, options) =>
      dispatch({ type: 'open', threadId, ...options }),
    closeTab: (threadId, options) =>
      dispatch({ type: 'close', threadId, ...options }),
    restoreClosedTab: () => dispatch({ type: 'restore' }),
    keepPreview: (threadId) => dispatch({ type: 'keep-preview', threadId }),
    deactivate: () => dispatch({ type: 'deactivate' }),
    closeAllTabs: () => dispatch({ type: 'close-all' }),
  };
}
