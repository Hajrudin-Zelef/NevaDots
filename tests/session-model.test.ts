import { expect, it, beforeEach } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { ApiError } from '../src/client/api-error';
import {
  getSessionStatus,
  logoutSession,
  refreshSessionStatus,
  resetSessionModelForTests,
  subscribeSessionStatus,
  useSessionStatus,
  type SessionTransport,
} from '../src/client/session-model';

/** Transport faux : le Modèle ne touche jamais le réseau en tests. */
function fakeTransport(overrides?: Partial<SessionTransport>): {
  transport: SessionTransport;
  calls: { getMe: number; postLogout: number };
} {
  const calls = { getMe: 0, postLogout: 0 };
  const transport: SessionTransport = {
    getMe: () => {
      calls.getMe += 1;
      return Promise.resolve({ username: 'sam', role: 'admin' });
    },
    postLogout: () => {
      calls.postLogout += 1;
      return Promise.resolve(undefined);
    },
    ...overrides,
  };
  return { transport, calls };
}

beforeEach(() => {
  resetSessionModelForTests();
});

it('démarre à unknown, sans statut inventé', () => {
  expect(getSessionStatus()).toEqual({
    state: 'unknown',
    username: null,
    role: null,
    profile: null,
  });
});

it('refresh passe à in et notifie les abonnés', async () => {
  const { transport, calls } = fakeTransport();
  const seen: string[] = [];
  const stop = subscribeSessionStatus(() =>
    seen.push(getSessionStatus().state),
  );
  const status = await refreshSessionStatus(transport);
  expect(status).toEqual({
    state: 'in',
    username: 'sam',
    role: 'admin',
    profile: {
      maxDots: null,
      monthlyLimitUsd: null,
      allowedProviders: null,
      allowedModels: null,
    },
  });
  expect(seen).toEqual(['in']);
  expect(calls.getMe).toBe(1);
  stop();
});

it('refresh remplit le profil, valeurs malformées neutralisées', async () => {
  const { transport } = fakeTransport({
    getMe: () =>
      Promise.resolve({
        username: 'sam',
        role: 'user',
        maxDots: 3,
        monthlyLimitUsd: 'x',
        allowedProviders: ['litellm', 42],
        allowedModels: ['a', 'b'],
      }),
  });
  const status = await refreshSessionStatus(transport);
  expect(status.profile).toEqual({
    maxDots: 3,
    monthlyLimitUsd: null,
    allowedProviders: null,
    allowedModels: ['a', 'b'],
  });
});

it('refresh 401 passe à out', async () => {
  const { transport } = fakeTransport({
    getMe: () => Promise.reject(new ApiError('Authentication required.', 401)),
  });
  const status = await refreshSessionStatus(transport);
  expect(status.state).toBe('out');
  expect(status.username).toBeNull();
});

it('erreur non-401 : statut conservé, pas de verdict mensonger', async () => {
  const ok = fakeTransport();
  await refreshSessionStatus(ok.transport);
  const ko = fakeTransport({
    getMe: () => Promise.reject(new Error('boom')),
  });
  const seen: string[] = [];
  const stop = subscribeSessionStatus(() =>
    seen.push(getSessionStatus().state),
  );
  await refreshSessionStatus(ko.transport);
  expect(getSessionStatus().state).toBe('in');
  expect(seen).toEqual([]);
  stop();
});

it('refresh concurrents : un seul GET /me partagé', async () => {
  const { transport, calls } = fakeTransport();
  const [a, b] = await Promise.all([
    refreshSessionStatus(transport),
    refreshSessionStatus(transport),
  ]);
  expect(calls.getMe).toBe(1);
  expect(a).toBe(b);
});

it('logout appelle le serveur puis passe à out même en échec', async () => {
  const ok = fakeTransport();
  let posts = 0;
  const ko = fakeTransport({
    postLogout: () => {
      posts += 1;
      return Promise.reject(new Error('réseau'));
    },
  });
  await refreshSessionStatus(ok.transport);
  await expect(logoutSession(ko.transport)).rejects.toThrow('réseau');
  expect(posts).toBe(1);
  expect(getSessionStatus().state).toBe('out');
});

it('useSessionStatus reflète le modèle dans une vue', async () => {
  const { transport } = fakeTransport();
  const states: string[] = [];
  function Probe(): null {
    states.push(useSessionStatus().state);
    return null;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  await act(async () => {
    await refreshSessionStatus(transport);
  });
  expect(states).toContain('unknown');
  expect(states.at(-1)).toBe('in');
  renderer!.unmount();
});
