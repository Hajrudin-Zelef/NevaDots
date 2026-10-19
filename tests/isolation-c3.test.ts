import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* déjà fermé */
    }
  }
});

describe('C3 — usage par compte (Store)', () => {
  it('usageSummary ne voit que la consommation de son compte', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    const storeA = new Store(db).forUser('user-1');
    const storeB = new Store(db).forUser('user-2');
    const now = Date.now();
    storeA.recordUsage({
      ts: now,
      dotId: 'dot-a',
      model: 'm',
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.01,
    });
    storeB.recordUsage({
      ts: now,
      dotId: 'dot-b',
      model: 'm',
      promptTokens: 200,
      completionTokens: 100,
      costUsd: 0.02,
    });
    expect(storeA.usageSummary(now).today.costUsd).toBeCloseTo(0.01);
    expect(storeA.usageSummary(now).today.runs).toBe(1);
    expect(storeB.usageSummary(now).today.costUsd).toBeCloseTo(0.02);
    expect(storeB.usageSummary(now).today.runs).toBe(1);
    // Par Dot : A ne voit que son Dot.
    expect(storeA.usageSummary(now).byDot).toHaveLength(1);
    expect(storeA.usageSummary(now).byDot[0].dotId).toBe('dot-a');
    // Store non lié : rien (fail-closed).
    expect(new Store(db).usageSummary(now).today.runs).toBe(0);
  });

  it('claimOrphans rattache la consommation legacy au propriétaire du Dot', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    const workspace = new WorkspaceStore(db, 'user-1');
    workspace.ensureSeed();
    const dot = workspace.dots()[0];
    // Le Store crée la table usage (le WorkspaceStore ne la connaît pas).
    new Store(db);
    // Ligne legacy (user_id NULL) écrite en SQL direct.
    db.prepare(
      'INSERT INTO usage (ts, dotId, model, promptTokens, completionTokens, cachedTokens, costUsd, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    ).run(Date.now(), dot.id, 'm', 100, 50, 0, 0.01);
    new Store(db).claimOrphans('user-1');
    const row = db
      .prepare('SELECT user_id FROM usage WHERE dotId=?')
      .get(dot.id) as { user_id: string };
    expect(row.user_id).toBe('user-1');
    // La consommation réclamée est visible par le bon compte.
    expect(
      new Store(db).forUser('user-1').usageSummary(Date.now()).today.runs,
    ).toBe(1);
  });
});

describe('C3 — événements par compte (Store)', () => {
  it('le détail (tâche + runs + events) de A est invisible pour B', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    const storeA = new Store(db).forUser('user-1');
    const storeB = new Store(db).forUser('user-2');
    const task = storeA.createTask('Faire X');
    expect(storeA.detail(task.id)).toBeDefined();
    expect(storeA.detail(task.id)?.events.length).toBeGreaterThan(0);
    expect(storeB.detail(task.id)).toBeUndefined();
    expect(storeB.task(task.id)).toBeUndefined();
  });
});

describe('C3 — routes providers : Admin seulement (HTTP)', () => {
  it('mutations + /credits → 403 pour un Utilisateur, lectures ouvertes', async () => {
    const { createApp } = await import('../src/server/app.js');
    const { AuthStore } = await import('../src/server/auth-store.js');
    const { Runner } = await import('../src/server/runner.js');
    const { Platform } = await import('../src/server/platform.js');
    const { loginSession, directSession } = await import('./auth-helpers.js');
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    const store = new Store(db).forUser('owner');
    const workspace = new WorkspaceStore(db, 'owner');
    workspace.ensureSeed();
    const auth = new AuthStore(':memory:');
    const runner = new Runner(store, {
      mode: 'sample',
      baseUrl: 'https://api.openai.com/v1',
    });
    const platform = new Platform(store, workspace, {
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    });
    const app = createApp({
      store,
      runner,
      config: { mode: 'sample', baseUrl: 'https://api.openai.com/v1' },
      auth,
      platform,
    });
    // Admin (rôle 'admin') + Utilisateur (rôle 'user').
    await auth.createUser('admin', 'admin-password-123', 'admin', 'admin-id');
    const cookieUser = await loginSession(app, auth);
    const cookieAdmin = await directSession(auth, 'admin');
    const userHeaders = { Cookie: cookieUser };
    const adminHeaders = { Cookie: cookieAdmin };
    // Mutations : l'Utilisateur est bloqué AVANT tout (403).
    for (const [method, path, body] of [
      ['PUT', '/api/providers/unknown', { key: 'sk-test' }],
      ['DELETE', '/api/providers/unknown', undefined],
      ['PUT', '/api/catalog/unknown', { models: ['m'] }],
      ['PUT', '/api/model-default', { provider: 'unknown', model: null }],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: {
          ...userHeaders,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(403);
    }
    // /credits : info financière → Admin seulement.
    expect(
      (await app.request('/api/credits', { headers: userHeaders })).status,
    ).toBe(403);
    expect(
      (await app.request('/api/credits', { headers: adminHeaders })).status,
    ).toBe(200);
    // L'Admin passe la garde (404 = provider inconnu, pas un refus).
    expect(
      (
        await app.request('/api/providers/unknown', {
          method: 'PUT',
          headers: { ...adminHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'sk-test' }),
        })
      ).status,
    ).toBe(404);
    // Lectures : ouvertes à tout compte connecté (sélecteur de modèles).
    expect(
      (await app.request('/api/providers', { headers: userHeaders })).status,
    ).toBe(200);
    auth.close();
  }, 30000);
});

describe('C3 — /api/usage par compte (HTTP)', () => {
  it('chaque compte ne voit que sa propre consommation', async () => {
    const { createApp } = await import('../src/server/app.js');
    const { AuthStore } = await import('../src/server/auth-store.js');
    const { Runner } = await import('../src/server/runner.js');
    const { loginSession, directSession } = await import('./auth-helpers.js');
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    const store = new Store(db).forUser('owner');
    const auth = new AuthStore(':memory:');
    const runner = new Runner(store, {
      mode: 'sample',
      baseUrl: 'https://api.openai.com/v1',
    });
    const app = createApp({
      store,
      runner,
      config: { mode: 'sample', baseUrl: 'https://api.openai.com/v1' },
      auth,
    });
    await auth.createUser('bob', 'bob-password-123', 'user', 'bob-id');
    const cookieOwner = await loginSession(app, auth);
    const cookieBob = await directSession(auth, 'bob');
    const now = Date.now();
    new Store(db).forUser('owner').recordUsage({
      ts: now,
      dotId: 'dot-owner',
      model: 'm',
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.01,
    });
    new Store(db).forUser('bob-id').recordUsage({
      ts: now,
      dotId: 'dot-bob',
      model: 'm',
      promptTokens: 200,
      completionTokens: 100,
      costUsd: 0.02,
    });
    const ownerUsage = (await (
      await app.request('/api/usage', { headers: { Cookie: cookieOwner } })
    ).json()) as { today: { runs: number; costUsd: number } };
    const bobUsage = (await (
      await app.request('/api/usage', { headers: { Cookie: cookieBob } })
    ).json()) as { today: { runs: number; costUsd: number } };
    expect(ownerUsage.today.runs).toBe(1);
    expect(ownerUsage.today.costUsd).toBeCloseTo(0.01);
    expect(bobUsage.today.runs).toBe(1);
    expect(bobUsage.today.costUsd).toBeCloseTo(0.02);
    auth.close();
  });
});
