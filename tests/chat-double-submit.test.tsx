import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

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

vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useRenderTool: () => null,
  useHumanInTheLoop: () => {},
  useAgent: () => ({
    agent: {
      messages: [],
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
import { Composer } from '../src/client/Composer';

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.clearAllMocks();
  runAgent.mockResolvedValue({ newMessages: [] });
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
