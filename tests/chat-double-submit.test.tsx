import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

// Uploads mockés : seul `/api/attachments` répond (fichier prêt) ; tout
// autre `fetch` (ex. journal computer) échoue comme sans réseau — les
// appelants l'encaissent déjà aujourd'hui.
const fetchMock = vi.hoisted(() =>
  vi.fn(async (url: string) => {
    if (url === '/api/attachments')
      return {
        ok: true,
        json: async () => ({
          attachments: [
            {
              id: 'srv-1',
              name: 'notes.txt',
              size: 12,
              mime: 'text/plain',
              category: 'text',
            },
          ],
        }),
      };
    throw new Error(`fetch non mocké en test : ${url}`);
  }),
);
vi.stubGlobal('fetch', fetchMock);

// Stockages en mémoire (certains modules les touchent au chargement ; Node n'en a pas).
{
  const makeStore = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    };
  };
  vi.stubGlobal('sessionStorage', makeStore());
  vi.stubGlobal('localStorage', makeStore());
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) =>
    clearTimeout(id),
  );
  vi.stubGlobal(
    'Image',
    class {
      set src(_value: string) {}
    },
  );
}

// Navigateur minimal pour les hooks (models-changed, etc.).
{
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn());
      return true;
    },
    setTimeout: (...args: [() => void, number]) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (...args: [() => void, number]) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
}

const runAgent = vi.hoisted(() => vi.fn());
const addMessage = vi.hoisted(() => vi.fn());
// Transcript courant du `useAgent` mocké — vide par défaut ; les tests
// qui en ont besoin y poussent leurs messages (réinitialisé après chaque
// test, voir `afterEach`).
const mockMessages = vi.hoisted(() => [] as unknown[]);

vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useRenderTool: () => null,
  useHumanInTheLoop: () => {},
  useAgent: () => ({
    agent: {
      messages: mockMessages,
      addMessage,
      subscribe: () => ({ unsubscribe: () => {} }),
    },
    isReady: true,
  }),
  useCopilotKit: () => ({
    copilotkit: {
      subscribe: () => ({ unsubscribe: () => {} }),
      connectAgent: async () => ({ unsubscribe: () => {} }),
      runAgent,
      stopAgent: vi.fn(),
    },
  }),
}));

vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({
    status: 'idle',
    error: null,
    start: vi.fn(),
    end: vi.fn(),
  }),
}));

vi.mock('../src/client/api', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api: async (path: string) => {
    if (path === '/models') return { default: null, providers: [] };
    if (path.endsWith('/page-context')) return null;
    return {};
  },
  isAuthed: () => false,
  login: async () => {},
  logout: async () => {},
}));

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: Record<string, unknown>) =>
    createElement('canvas', {
      'data-state': props.state,
      'data-size': props.size,
      'aria-label': props['aria-label'],
    }),
}));

import { Chat } from '../src/client/Chat';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { Composer } from '../src/client/Composer';

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.clearAllMocks();
  mockMessages.length = 0;
  runAgent.mockResolvedValue({ newMessages: [] });
  // Chaque test repart d'un historique / de brouillons vides.
  (
    globalThis as unknown as { localStorage: { clear: () => void } }
  ).localStorage.clear();
});

const dot = {
  id: 'dot-1',
  spaceId: 'space-1',
  name: 'Leo',
  instructions: 'Aide.',
  provider: null,
  model: null,
  reasoningEffort: null,
  avatar: 'classic',
  createdAt: 0,
} as never;

const thread = { id: 'thread-1', dotId: 'dot-1', title: 'T' } as never;

async function mountChat() {
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(Chat, {
        thread,
        dot,
        onConsumed: () => {},
        voiceReady: false,
        calls: [],
        paused: false,
        onSaved: () => {},
        onSchedule: () => {},
        railOpen: false,
        onRailChange: () => {},
      }),
    );
    roots.push(root!);
  });
  await act(async () => {});
  return roots[roots.length - 1];
}

async function typeDraft(root: ReturnType<typeof create>, text: string) {
  const composer = root.root.findByType(Composer);
  await act(async () => {
    composer.props.onTextChange(text);
  });
  await act(async () => {});
}

function submitForm(root: ReturnType<typeof create>) {
  const form = root.root.findByType('form' as never) as unknown as {
    props: { onSubmit: (event: { preventDefault: () => void }) => void };
  };
  form.props.onSubmit({ preventDefault: () => {} });
}

/** Simule Alt+Entrée : appelle directement `onQueueFront` du composer. */
async function queueFront(root: ReturnType<typeof create>) {
  await act(async () => {
    root.root.findByType(Composer).props.onQueueFront?.();
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
}

/** Ajoute un fichier texte via l'input caché d'AttachmentBar, et attend
 *  la fin de l'upload (le bouton d'envoi cesse d'être désactivé par
 *  `attachments.uploading`). */
async function attachTextFile(
  root: ReturnType<typeof create>,
  name = 'notes.txt',
  content = 'contenu joint',
) {
  const file = new File([content], name, { type: 'text/plain' });
  const input = root.root
    .findAllByType('input')
    .find(
      (node) => node.props.type === 'file' && node.props.multiple === true,
    );
  if (!input) throw new Error('input fichier introuvable');
  await act(async () => {
    input.props.onChange({ target: { files: [file], value: '' } });
  });
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    if (!root.root.findByType(Composer).props.submitDisabled) return;
  }
  throw new Error("l'upload de la pièce jointe ne s'est pas terminé");
}

function readHistory(): { prompt: string; mode: string }[] {
  const raw = (
    globalThis as unknown as { localStorage: { getItem: (k: string) => string | null } }
  ).localStorage.getItem('nevadots:prompt-history');
  return raw ? (JSON.parse(raw) as { prompt: string; mode: string }[]) : [];
}

/** Simule « Répondre » sur une sélection : ouvre la carte de citation. */
async function openQuote(root: ReturnType<typeof create>, text: string) {
  await act(async () => {
    root.root.findByType(ChatTranscript).props.onQuote?.(text);
  });
  await act(async () => {});
}

async function setQuoteComment(root: ReturnType<typeof create>, comment: string) {
  await act(async () => {
    root.root
      .findByProps({ 'aria-label': 'Commentaire sur la citation' })
      .props.onChange({ target: { value: comment } });
  });
  await act(async () => {});
}

function quoteCardOpen(root: ReturnType<typeof create>): boolean {
  return (
    root.root.findAllByProps({ 'aria-label': 'Commentaire sur la citation' })
      .length > 0
  );
}

function quoteCardText(root: ReturnType<typeof create>): string | null {
  const quotes = root.root.findAllByType('blockquote');
  if (!quotes.length) return null;
  return quotes.map((quote) => quote.children.join('')).join('');
}

function sentContents(): string[] {
  return addMessage.mock.calls.map((call) => String(call[0].content));
}

it('double Entrée rapprochée → un seul envoi (sendingRef)', async () => {
  runAgent.mockResolvedValue({ newMessages: [] });
  const root = await mountChat();
  await typeDraft(root, 'bonjour');
  await act(async () => {
    submitForm(root);
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(1);
  expect(runAgent).toHaveBeenCalledTimes(1);
});

it('échec du tour → brouillon restauré, entrée d’historique retirée', async () => {
  runAgent.mockResolvedValue({ newMessages: [] });
  const root = await mountChat();
  await typeDraft(root, 'à restaurer');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  // addMessage a bien eu lieu (un seul envoi), mais le tour a échoué
  // (aucune réponse) : le brouillon revient dans le composer.
  expect(addMessage).toHaveBeenCalledTimes(1);
  const composer = root.root.findByType(Composer);
  expect(composer.props.text).toBe('à restaurer');
  const historyRaw = (
    globalThis as unknown as { localStorage: { getItem: (k: string) => string | null } }
  ).localStorage.getItem('nevadots:prompt-history');
  const history = historyRaw ? (JSON.parse(historyRaw) as unknown[]) : [];
  expect(history).toHaveLength(0);
});

// --- Fix round 1/5 : brouillon + citation, quote et file cohérentes ---

it('envoi avec brouillon + quote : le brouillon est préservé (texte envoyé + historique)', async () => {
  runAgent.mockResolvedValue({
    newMessages: [{ role: 'assistant', content: 'ok' }],
  });
  const root = await mountChat();
  await openQuote(root, 'texte cité');
  await setQuoteComment(root, 'mon commentaire');
  await typeDraft(root, 'ma question');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(1);
  const content = sentContents()[0];
  expect(content).toContain('ma question');
  expect(content).toContain('mon commentaire');
  expect(content).toContain('[Citation : texte cité]');
  expect(content.indexOf('ma question')).toBeLessThan(
    content.indexOf('mon commentaire'),
  );
  expect(content.indexOf('mon commentaire')).toBeLessThan(
    content.indexOf('[Citation'),
  );
  // L'historique retient le texte utilisateur, sans le bloc de citation.
  const history = readHistory();
  expect(history).toHaveLength(1);
  expect(history[0].prompt).toBe('ma question\n\nmon commentaire');
  expect(history[0].prompt).not.toContain('[Citation');
  // Carte consommée, brouillon vidé après succès.
  expect(quoteCardOpen(root)).toBe(false);
  expect(root.root.findByType(Composer).props.text).toBe('');
});

it('échec du tour avec quote : carte + commentaire restaurés, brouillon restauré', async () => {
  runAgent.mockResolvedValue({ newMessages: [] });
  const root = await mountChat();
  await openQuote(root, 'texte cité');
  await setQuoteComment(root, 'à garder');
  await typeDraft(root, 'à restaurer');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(1);
  expect(root.root.findByType(Composer).props.text).toBe('à restaurer');
  expect(quoteCardOpen(root)).toBe(true);
  expect(quoteCardText(root)).toBe('texte cité');
  expect(
    root.root.findByProps({ 'aria-label': 'Commentaire sur la citation' })
      .props.value,
  ).toBe('à garder');
  expect(readHistory()).toHaveLength(0);
});

it('mise en file avec quote : carte consommée, citation appliquée une seule fois', async () => {
  let resolveFirst!: (value: unknown) => void;
  runAgent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  runAgent.mockResolvedValue({
    newMessages: [{ role: 'assistant', content: 'ok' }],
  });
  const root = await mountChat();
  await typeDraft(root, 'premier');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(1);
  // Tour 1 en cours : second message avec citation → mis en file.
  await openQuote(root, 'citation une');
  await setQuoteComment(root, 'commentaire un');
  await typeDraft(root, 'deuxième');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  // Carte consommée à la mise en file, rien envoyé de plus pour l'instant.
  expect(quoteCardOpen(root)).toBe(false);
  expect(addMessage).toHaveBeenCalledTimes(1);
  expect(
    root.root.findAllByProps({ className: 'chat-bubble user pending' }),
  ).toHaveLength(1);
  // Fin du tour 1 : le message en file s'exécute.
  await act(async () => {
    resolveFirst({ newMessages: [{ role: 'assistant', content: 'ok' }] });
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(2);
  const second = sentContents()[1];
  expect(second).toContain('deuxième');
  expect(second).toContain('commentaire un');
  expect(second).toContain('[Citation : citation une]');
  expect(second.split('[Citation').length - 1).toBe(1);
  // L'historique du tour en file retient le texte utilisateur.
  const history = readHistory();
  expect(history).toHaveLength(2);
  expect(history[0].prompt).toBe('deuxième\n\ncommentaire un');
  expect(history[0].prompt).not.toContain('[Citation');
  expect(history[1].prompt).toBe('premier');
});

it('tour en file : une quote fraîche posée en attendant survit à l’exécution', async () => {
  let resolveFirst!: (value: unknown) => void;
  runAgent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  runAgent.mockResolvedValue({
    newMessages: [{ role: 'assistant', content: 'ok' }],
  });
  const root = await mountChat();
  await typeDraft(root, 'premier');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  await openQuote(root, 'citation A');
  await typeDraft(root, 'deuxième');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  expect(quoteCardOpen(root)).toBe(false);
  // En attendant, l'utilisateur prépare son prochain message avec une
  // autre citation (sans taper de brouillon : le brouillon tapé pendant
  // l'exécution d'un tour en file est vidé par `runPrompt`, comportement
  // pré-existant hors périmètre de ce correctif).
  await openQuote(root, 'citation B');
  expect(quoteCardOpen(root)).toBe(true);
  expect(quoteCardText(root)).toBe('citation B');
  await act(async () => {
    resolveFirst({ newMessages: [{ role: 'assistant', content: 'ok' }] });
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(2);
  const second = sentContents()[1];
  expect(second).toContain('[Citation : citation A]');
  expect(second).not.toContain('citation B');
  // La carte fraîche est toujours là.
  expect(quoteCardOpen(root)).toBe(true);
  expect(quoteCardText(root)).toBe('citation B');
});

// --- Vague de correction finale : Alt+Entrée via prepareSend (Important 1) ---

it('Alt+Entrée hors tour avec pièces jointes + citation : tout part avec le message, carte consommée', async () => {
  runAgent.mockResolvedValue({
    newMessages: [{ role: 'assistant', content: 'ok' }],
  });
  const root = await mountChat();
  await attachTextFile(root);
  await openQuote(root, 'texte cité');
  await setQuoteComment(root, 'mon commentaire');
  await typeDraft(root, 'ma question');
  await queueFront(root);
  expect(addMessage).toHaveBeenCalledTimes(1);
  const content = sentContents()[0];
  expect(content).toContain('ma question');
  expect(content).toContain('mon commentaire');
  expect(content).toContain('[Citation : texte cité]');
  expect(content).toContain('[Fichier : notes.txt');
  expect(content).toContain('contenu joint');
  // Carte consommée, brouillon vidé.
  expect(quoteCardOpen(root)).toBe(false);
  expect(root.root.findByType(Composer).props.text).toBe('');
  // L'historique retient le texte utilisateur + les noms de pièces jointes.
  const history = readHistory() as unknown as {
    prompt: string;
    mode: string;
    attachments?: string[];
  }[];
  expect(history).toHaveLength(1);
  expect(history[0].prompt).toBe('ma question\n\nmon commentaire');
  expect(history[0].attachments).toEqual(['notes.txt']);
  // Pièces jointes consommées : plus rien en attente.
  const pendingRaw = (
    globalThis as unknown as {
      localStorage: { getItem: (k: string) => string | null };
    }
  ).localStorage.getItem('nevadots:attachments:thread:thread-1');
  expect(pendingRaw ? JSON.parse(pendingRaw) : []).toEqual([]);
});

it('Alt+Entrée pendant un tour avec citation : le message en file porte la citation, pas le message suivant', async () => {
  let resolveFirst!: (value: unknown) => void;
  runAgent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  runAgent.mockResolvedValue({
    newMessages: [{ role: 'assistant', content: 'ok' }],
  });
  const root = await mountChat();
  await typeDraft(root, 'premier');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(1);
  // Tour 1 en cours : Alt+Entrée avec citation → tête de file.
  await openQuote(root, 'citation une');
  await setQuoteComment(root, 'commentaire un');
  await typeDraft(root, 'deuxième');
  await queueFront(root);
  // Carte consommée à la mise en file, rien envoyé de plus pour l'instant.
  expect(quoteCardOpen(root)).toBe(false);
  expect(addMessage).toHaveBeenCalledTimes(1);
  expect(
    root.root.findAllByProps({ className: 'chat-bubble user pending' }),
  ).toHaveLength(1);
  // Fin du tour 1 : le message en file s'exécute avec sa citation.
  await act(async () => {
    resolveFirst({ newMessages: [{ role: 'assistant', content: 'ok' }] });
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(2);
  const second = sentContents()[1];
  expect(second).toContain('deuxième');
  expect(second).toContain('commentaire un');
  expect(second).toContain('[Citation : citation une]');
  expect(second.split('[Citation').length - 1).toBe(1);
  // Message suivant : une carte fraîche ne récupère pas l'ancienne citation.
  await openQuote(root, 'citation B');
  await typeDraft(root, 'troisième');
  await act(async () => {
    submitForm(root);
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  expect(addMessage).toHaveBeenCalledTimes(3);
  const third = sentContents()[2];
  expect(third).toContain('[Citation : citation B]');
  expect(third).not.toContain('citation une');
});

// --- Vague de correction finale : repli outils mémoïsé (Important 4) ---

it('repli outils mémoïsé : une frappe au composer ne re-parse pas les arguments', async () => {
  const argsJson = JSON.stringify({ query: 'dette technique' });
  mockMessages.push(
    { id: 'u1', role: 'user', content: 'Cherche' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-search',
          type: 'function',
          function: { name: 'search_web', arguments: argsJson },
        },
      ],
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-search',
      content: JSON.stringify({ results: [{}, {}] }),
    },
  );
  const parseSpy = vi.spyOn(JSON, 'parse');
  const countArgsParses = () =>
    parseSpy.mock.calls.filter(([arg]) => arg === argsJson).length;
  const root = await mountChat();
  // Le repli a bien parsé les arguments une fois au montage.
  expect(countArgsParses()).toBeGreaterThan(0);
  const afterMount = countArgsParses();
  await typeDraft(root, 'taper');
  await act(async () => {});
  expect(countArgsParses()).toBe(afterMount);
  parseSpy.mockRestore();
});
