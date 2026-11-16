import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

// Stockages en mémoire (certains modules les touchent au chargement).
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
  // Télémétrie setup (`trackSetupStep`) : succès silencieux.
  vi.stubGlobal('fetch', async () => ({ ok: true }));
}

// Navigateur minimal pour App (hash, garde page-sale, thème, polling).
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
    confirm: () => true,
    innerWidth: 1280,
    location: { href: 'http://localhost/' },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { style: { setProperty: () => {} } },
  });
  vi.stubGlobal('location', { hash: '', pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: () => {} });
}

const apiCalls = vi.hoisted(
  () => [] as { path: string; method?: string; body?: unknown }[],
);
const dotFixture = vi.hoisted(() => ({
  id: 'dot-1',
  userId: 'u1',
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  name: 'Leo',
  instructions: 'Aide.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
  provider: null,
  model: null,
  reasoningEffort: null,
  avatar: 'classic',
}));
const workspaceFixture = vi.hoisted(() => ({
  spaces: [],
  dots: [dotFixture],
  conversations: [] as unknown[],
  setup: { model: true, browser: true, voice: false, slack: '', missing: [] },
  calls: [],
}));
const stateFixture = vi.hoisted(() => ({
  settings: {
    name: 'Test',
    paused: false,
    researchAllowed: true,
    memoryAllowed: true,
    replyStyle: 'standard',
    replyLanguage: 'fr',
    ttsMode: 'browser',
    ttsVoice: '',
    ttsRate: 1,
    ttsPauseSentenceMs: 300,
    ttsPauseParagraphMs: 600,
    ttsProvider: null,
    ttsModel: null,
  },
  tasks: [],
  memories: [],
  mode: 'sample',
  configured: true,
}));

vi.mock('../src/client/api', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api: async (path: string, method?: string, body?: unknown) => {
    apiCalls.push({ path, method, body });
    if (path === '/state') return stateFixture;
    if (path === '/workspace') return workspaceFixture;
    if (path === '/models') return { default: null, providers: [] };
    if (path === '/metrics')
      return { netIn: null, netOut: null, uptime: 0, model: null };
    if (path === '/conversations' && method === 'POST') {
      const conv = {
        id: 'conv-1',
        dotId: 'dot-1',
        ownerId: 'u1',
        title: (body as { title?: string })?.title ?? '',
        createdAt: 1,
        updatedAt: 1,
        isMaster: false,
      };
      workspaceFixture.conversations.push(conv);
      return conv;
    }
    if (path.endsWith('/page-context')) return null;
    return {};
  },
  sessionTransport: {
    getMe: async () => ({ username: 'test', role: 'user' }),
    postLogout: async () => ({}),
  },
}));

const addMessage = vi.hoisted(() => vi.fn());
const runAgent = vi.hoisted(() => vi.fn());

vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotKitProvider: ({ children }: { children: unknown }) =>
    children as never,
  CopilotChatToolCallsView: () => null,
  useRenderTool: () => null,
  useHumanInTheLoop: () => {},
  useAgent: () => ({
    agent: {
      messages: [],
      addMessage,
      setMessages: () => {},
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

vi.mock('../src/client/useComputerActivity', () => ({
  useComputerActivity: () => ({ runs: [], connected: false, error: '' }),
}));

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: Record<string, unknown>) =>
    createElement('canvas', {
      'data-state': props.state,
      'data-size': props.size,
      'aria-label': props['aria-label'],
    }),
}));

import { App } from '../src/client/App';
import { Composer } from '../src/client/Composer';

const roots: ReactTestRenderer[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.clearAllMocks();
  apiCalls.length = 0;
  workspaceFixture.conversations.length = 0;
  runAgent.mockResolvedValue({ newMessages: [] });
  (
    globalThis as unknown as { localStorage: { clear: () => void } }
  ).localStorage.clear();
});

/** Monte App et attend le composer d'accueil (session + workspace chargés). */
async function mountApp(): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(App));
    roots.push(root!);
  });
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    try {
      root!.root.findByType(Composer);
      return root!;
    } catch {
      // Pas encore là : session ou workspace en cours de chargement.
    }
  }
  throw new Error("le composer d'accueil n'est jamais apparu");
}

it('Alt+Entrée sur composer d’accueil vide ne crée aucune conversation', async () => {
  const root = await mountApp();
  const composer = root.root.findByType(Composer);
  expect(composer.props.text).toBe('');
  await act(async () => {
    composer.props.onQueueFront?.();
  });
  await act(async () => {});
  await act(async () => {});
  expect(
    apiCalls.filter(
      (call) => call.path === '/conversations' && call.method === 'POST',
    ),
  ).toHaveLength(0);
  expect(workspaceFixture.conversations).toHaveLength(0);
});

it('Alt+Entrée avec un brouillon crée bien la conversation (témoin positif)', async () => {
  const root = await mountApp();
  await act(async () => {
    root.root.findByType(Composer).props.onTextChange('bonjour');
  });
  await act(async () => {});
  await act(async () => {
    root.root.findByType(Composer).props.onQueueFront?.();
  });
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  const posts = apiCalls.filter(
    (call) => call.path === '/conversations' && call.method === 'POST',
  );
  expect(posts).toHaveLength(1);
  expect((posts[0].body as { title?: string }).title).toBe('bonjour');
  expect(workspaceFixture.conversations).toHaveLength(1);
});
