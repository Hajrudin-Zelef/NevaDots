import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { loginSession } from './auth-helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function fixture() {
  const store = new Store(':memory:').forUser('owner');
  const ws = new WorkspaceStore(':memory:', 'owner');
  const auth = new AuthStore(':memory:');
  cleanup.push(() => {
    store.close();
    ws.close();
    auth.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    auth,
  });
  const cookie = await loginSession(app, auth);
  const space = ws.createSpace('Atelier', '');
  const dot = ws.createDot(space.id, 'Scout', 'Aide-moi', true, true);
  const api = (url: string, init?: RequestInit) =>
    app.request(url, {
      ...init,
      headers: {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        Cookie: cookie,
      },
    });
  return { ws, api, dot };
}

it('setDotResearchAllowed persiste le flag par Dot', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => ws.close());
  const space = ws.createSpace('Atelier', '');
  const dot = ws.createDot(space.id, 'Scout', 'Aide-moi', true, true);
  expect(ws.dot(dot.id)?.researchAllowed).toBe(true);
  expect(ws.setDotResearchAllowed(dot.id, false).researchAllowed).toBe(false);
  expect(ws.dot(dot.id)?.researchAllowed).toBe(false);
  expect(() => ws.setDotResearchAllowed('missing', true)).toThrow();
});

it('PUT /dots/:id/research valide et persiste (400/404/200)', async () => {
  const { api, dot } = await fixture();
  const bad = await api(`/api/dots/${dot.id}/research`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed: 'oui' }),
  });
  expect(bad.status).toBe(400);
  const missing = await api('/api/dots/missing/research', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed: false }),
  });
  expect(missing.status).toBe(404);
  const off = await api(`/api/dots/${dot.id}/research`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed: false }),
  });
  expect(off.status).toBe(200);
  expect(
    ((await off.json()) as { researchAllowed: boolean }).researchAllowed,
  ).toBe(false);
});
