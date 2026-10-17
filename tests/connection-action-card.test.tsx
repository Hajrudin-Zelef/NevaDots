import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const api = vi.hoisted(() => vi.fn());

vi.mock('../src/client/api', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api,
  authHeaders: () => ({}),
  hasToken: () => false,
  setToken: () => {},
}));

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: () => null,
}));

import { ConnectionActionCard } from '../src/client/ConnectionActionCard';

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.clearAllMocks();
});

const args = { approvalId: 'a1', summary: 'Envoyer un e-mail de test.' };

function mountCard(overrides: Record<string, unknown> = {}) {
  const respond = vi.fn(async (_result: unknown): Promise<void> => {});
  const props = {
    args,
    status: 'running',
    result: undefined,
    respond,
    threadId: 'thread-1',
    toolCallId: 'tc1',
    ...overrides,
  };
  let root: ReturnType<typeof create>;
  return (async () => {
    await act(async () => {
      root = create(createElement(ConnectionActionCard, props as never));
      roots.push(root!);
    });
    await act(async () => {});
    return { root: roots[roots.length - 1], respond };
  })();
}

function buttons(root: ReturnType<typeof create>) {
  return root.root.findAllByType('button');
}

function postedActions() {
  return api.mock.calls.filter(
    ([path, method]: unknown[]) =>
      typeof path === 'string' &&
      path.includes('/connection-actions') &&
      method === 'POST',
  );
}

beforeEach(() => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/connection-approvals/a1'))
      return {
        id: 'a1',
        connection: 'Mail',
        title: 'send mail',
        description: 'Envoie un e-mail.',
        arguments: { to: 'a@example.com' },
        expiresAt: Date.now() + 3600000,
      };
    if (path.endsWith('/connection-actions/tc1')) return null;
    throw new Error(`route inattendue: ${path}`);
  });
});

it('refus sans reçu : respond declined, aucun POST', async () => {
  const { root, respond } = await mountCard();
  const refuse = buttons(root).find((b) =>
    String(b.props.children).includes('Refuser'),
  );
  expect(refuse).toBeTruthy();
  await act(async () => {
    await refuse!.props.onClick();
  });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0][0]).toMatchObject({ approved: false });
  expect(postedActions()).toHaveLength(0);
});

it('reçu existant : pas de bouton Refuser, Continuer ne rejoue pas', async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/connection-approvals/a1'))
      return {
        id: 'a1',
        connection: 'Mail',
        title: 'send mail',
        description: 'Envoie un e-mail.',
        arguments: { to: 'a@example.com' },
        expiresAt: Date.now() + 3600000,
      };
    if (path.endsWith('/connection-actions/tc1'))
      return {
        approvalId: 'a1',
        status: 'done',
        result: { isError: false, text: 'Envoyé.' },
      };
    throw new Error(`route inattendue: ${path}`);
  });
  const { root, respond } = await mountCard({ status: 'running' });
  const labels = buttons(root).map((b) =>
    Array.isArray(b.props.children)
      ? b.props.children.join('')
      : String(b.props.children ?? ''),
  );
  expect(labels.some((l) => l.includes('Refuser'))).toBe(false);
  const continuer = buttons(root).find((b) =>
    String(
      Array.isArray(b.props.children)
        ? b.props.children.join('')
        : (b.props.children ?? ''),
    ).includes('Continuer'),
  );
  expect(continuer).toBeTruthy();
  await act(async () => {
    await continuer!.props.onClick();
  });
  // Reprise du reçu, pas de POST, et jamais d'approbation inversée.
  expect(postedActions()).toHaveLength(0);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0][0]).toMatchObject({ approved: true });
});

it('reçu existant + decide(false) tardif : pas de POST, respond declined', async () => {
  const { respondToLateDecline } =
    await import('../src/client/ConnectionActionCard.js');
  const respond = vi.fn(async (_result: unknown): Promise<void> => {});
  await respondToLateDecline(respond);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0][0]).toMatchObject({ approved: false });
  // Aucun appel réseau dans ce chemin : seul respond est invoqué.
  expect(
    api.mock.calls.filter(([p]) => String(p).includes('POST')).length,
  ).toBe(0);
});
