import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace.js';
import { sortSessions } from '../src/client/session-groups';
import { Store } from '../src/server/store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { loginSession } from './auth-helpers.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function seeded() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.ensureSeed();
  stores.push(workspace);
  return workspace;
}

describe('renameThread', () => {
  it('renames and bumps updatedAt', () => {
    const workspace = seeded();
    const dot = workspace.dots()[0];
    const created = workspace.bindThread(
      'thread-rename',
      dot.id,
      'Ancien titre',
    );
    expect(created.updatedAt ?? null).toBeNull();

    const renamed = workspace.renameThread(
      'thread-rename',
      '  Nouveau titre  ',
    );
    expect(renamed.title).toBe('Nouveau titre');
    expect(typeof renamed.updatedAt).toBe('number');
    expect(renamed.updatedAt!).toBeGreaterThanOrEqual(created.createdAt);
    expect(renamed.isMaster).toBe(created.isMaster);

    const stored = workspace.conversations()[0];
    expect(stored.title).toBe('Nouveau titre');
    expect(stored.updatedAt).toBe(renamed.updatedAt);
  });
  it('renaming moves the conversation back on top of the sorted list', () => {
    const workspace = seeded();
    const dot = workspace.dots()[0];
    workspace.bindThread('old', dot.id, 'Vieille');
    // Recule artificiellement la vieille conversation de 30 jours
    // (même motif que les tests d'isolation : accès au `db` privé).
    (workspace as unknown as { db: DatabaseSync }).db
      .prepare('UPDATE thread_bindings SET createdAt=? WHERE id=?')
      .run(Date.now() - 30 * 24 * 3_600_000, 'old');
    const fresh = workspace.bindThread('fresh', dot.id, 'Récente');
    const db = (workspace as unknown as { db: DatabaseSync }).db;
    // « Récente » date d'il y a une heure : le renommage (maintenant) doit
    // passer strictement devant, sans dépendre de la milliseconde.
    db.prepare('UPDATE thread_bindings SET createdAt=? WHERE id=?').run(
      Date.now() - 3_600_000,
      'fresh',
    );
    expect(sortSessions(workspace.conversations())[0].id).toBe(fresh.id);

    workspace.renameThread('old', 'Vieille renommée');
    expect(sortSessions(workspace.conversations())[0].id).toBe('old');
  });
  it('rejects unknown conversations and invalid titles', () => {
    const workspace = seeded();
    const dot = workspace.dots()[0];
    workspace.bindThread('thread-rename-bad', dot.id, 'Titre');
    expect(() => workspace.renameThread('missing', 'X')).toThrow();
    expect(() => workspace.renameThread('thread-rename-bad', '   ')).toThrow();
    expect(() =>
      workspace.renameThread('thread-rename-bad', 'x'.repeat(121)),
    ).toThrow();
    expect(workspace.conversations()[0].title).toBe('Titre');
  });
});

// --- Route PATCH /api/conversations/:id (même harnais que page-routes) ---

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function appFixture() {
  const store = new Store(':memory:').forUser('owner');
  const ws = new WorkspaceStore(':memory:', 'owner');
  ws.ensureSeed();
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
  const api = (url: string, init?: RequestInit) =>
    app.request(url, {
      ...init,
      headers: {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        Cookie: cookie,
      },
    });
  return { ws, app, api };
}

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('PATCH /api/conversations/:id', () => {
  it('renames, returns the updated conversation, and rejects bad input', async () => {
    const { ws, api } = await appFixture();
    const dot = ws.dots()[0];
    ws.bindThread('thread-patch', dot.id, 'Ancien titre');

    const res = await api(
      '/api/conversations/thread-patch',
      patch({
        title: '  Nouveau titre  ',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; updatedAt: number };
    expect(body.title).toBe('Nouveau titre');
    expect(typeof body.updatedAt).toBe('number');
    expect(ws.conversations()[0].title).toBe('Nouveau titre');

    const missing = await api(
      '/api/conversations/unknown',
      patch({ title: 'X' }),
    );
    expect(missing.status).toBe(404);
    const bad = await api(
      '/api/conversations/thread-patch',
      patch({ title: '   ' }),
    );
    expect(bad.status).toBe(400);
    const badType = await api(
      '/api/conversations/thread-patch',
      patch({ title: 42 }),
    );
    expect(badType.status).toBe(400);
    expect(ws.conversations()[0].title).toBe('Nouveau titre');
  });
  it('requires a session', async () => {
    const { ws, app } = await appFixture();
    const dot = ws.dots()[0];
    ws.bindThread('thread-patch-auth', dot.id, 'Titre');
    const res = await app.request(
      '/api/conversations/thread-patch-auth',
      patch({ title: 'X' }),
    );
    expect(res.status).toBe(401);
  });
});
