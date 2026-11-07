import { expect, it, vi, beforeEach } from 'vitest';
import { act, create } from 'react-test-renderer';
import { ApiError } from '../src/client/api';
vi.mock('../src/client/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/client/api')>();
  return { ...mod, api: vi.fn() };
});
import { api } from '../src/client/api';
import {
  getSessionStatus,
  logoutSession,
  refreshSessionStatus,
  resetSessionModelForTests,
  subscribeSessionStatus,
  useSessionStatus,
} from '../src/client/session-model';
import { createElement } from 'react';

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
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
  mockedApi.mockResolvedValue({ username: 'sam', role: 'admin' });
  const seen: string[] = [];
  const stop = subscribeSessionStatus(() =>
    seen.push(getSessionStatus().state),
  );
  const status = await refreshSessionStatus();
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
  expect(mockedApi).toHaveBeenCalledTimes(1);
  expect(mockedApi).toHaveBeenCalledWith('/auth/me');
  stop();
});

it('refresh remplit le profil, valeurs malformées neutralisées', async () => {
  mockedApi.mockResolvedValue({
    username: 'sam',
    role: 'user',
    maxDots: 3,
    monthlyLimitUsd: 'x',
    allowedProviders: ['litellm', 42],
    allowedModels: ['a', 'b'],
  });
  const status = await refreshSessionStatus();
  expect(status.profile).toEqual({
    maxDots: 3,
    monthlyLimitUsd: null,
    allowedProviders: null,
    allowedModels: ['a', 'b'],
  });
});

it('refresh 401 passe à out', async () => {
  mockedApi.mockRejectedValue(new ApiError('Authentication required.', 401));
  const status = await refreshSessionStatus();
  expect(status.state).toBe('out');
  expect(status.username).toBeNull();
});

it('erreur non-401 : statut conservé, pas de verdict mensonger', async () => {
  mockedApi
    .mockResolvedValueOnce({ username: 'sam', role: 'user' })
    .mockRejectedValueOnce(new Error('boom'));
  await refreshSessionStatus();
  const seen: string[] = [];
  const stop = subscribeSessionStatus(() =>
    seen.push(getSessionStatus().state),
  );
  await refreshSessionStatus();
  expect(getSessionStatus().state).toBe('in');
  expect(seen).toEqual([]);
  stop();
});

it('refresh concurrents : un seul GET /me partagé', async () => {
  mockedApi.mockResolvedValue({ username: 'sam', role: 'user' });
  const [a, b] = await Promise.all([
    refreshSessionStatus(),
    refreshSessionStatus(),
  ]);
  expect(mockedApi).toHaveBeenCalledTimes(1);
  expect(a).toBe(b);
});

it('logout appelle le serveur puis passe à out même en échec', async () => {
  mockedApi
    .mockResolvedValueOnce({ username: 'sam', role: 'admin' })
    .mockRejectedValueOnce(new Error('réseau'));
  await refreshSessionStatus();
  await expect(logoutSession()).rejects.toThrow('réseau');
  expect(mockedApi).toHaveBeenCalledWith('/auth/logout', 'POST');
  expect(getSessionStatus().state).toBe('out');
});

it('useSessionStatus reflète le modèle dans une vue', async () => {
  mockedApi.mockResolvedValue({ username: 'sam', role: 'user' });
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
    await refreshSessionStatus();
  });
  expect(states).toContain('unknown');
  expect(states.at(-1)).toBe('in');
  renderer!.unmount();
});
