/**
 * Phase E — module Compte + providers/modèles + limites.
 * AuthStore (limites / droits), WorkspaceStore (maxDots, modèles
 * autorisés, suppression cascade), Store (coût mensuel), runner
 * (suppression des threads), routes Admin + filtrage providers/catalog.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, of, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { ProviderRegistry } from '../src/server/providers.js';
import { Runner } from '../src/server/runner.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Config } from '../src/server/research.js';

// Mock BuiltInAgent (comme tests/dot-agent-channel.test.ts) : le DotAgent
// étend BuiltInAgent, les tours ne doivent pas appeler un vrai modèle.
const inner = vi.hoisted(() => ({
  configure: vi.fn<(options: unknown) => void>(),
  run: vi.fn<(input: RunAgentInput) => Observable<BaseEvent>>(),
  abortRun: vi.fn(),
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@copilotkit/runtime/v2')>();
  return {
    ...original,
    BuiltInAgent: class {
      constructor(options: unknown) {
        inner.configure(options);
      }
      run = inner.run;
      abortRun = inner.abortRun;
    },
  };
});

const ADMIN = 'admin-1';
const USER = 'user-1';
const OTHER = 'user-2';

const dbPaths: string[] = [];
afterEach(() => {
  for (const path of dbPaths.splice(0)) rmSync(path, { force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nevadots-e-'));
  const path = join(dir, 'test.sqlite');
  dbPaths.push(path);
  return path;
}
function dbOf(store: object) {
  return (store as { db: DatabaseSync }).db;
}
function storeDbOf(store: Store) {
  return dbOf(store);
}
/** Mémoire pour ProviderRegistry (comme tests/models.test.ts). */
class MemoryConfigStore {
  private values = new Map<string, string>();
  configGet(key: string) {
    return this.values.get(key);
  }
  configSet(key: string, value: string) {
    this.values.set(key, value);
  }
  configDelete(key: string) {
    this.values.delete(key);
  }
  configList(prefix: string) {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
/** JSON + cookie de session (sans écraser le Content-Type). */
const authJson = (body: unknown, headers: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith('nevadots-session='));
const stores: { close(): void }[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('AuthStore — limites / droits (Phase E)', () => {
  it('crée un Utilisateur avec limites + listes, un Admin sans restriction', async () => {
    const auth = new AuthStore(':memory:');
    stores.push(auth);
    const user = await auth.createUser(
      'marie',
      'a-strong-password',
      'user',
      undefined,
      {
        allowedProviders: ['openai'],
        allowedModels: ['gpt-5'],
        monthlyLimitUsd: 20,
        maxDots: 3,
      },
    );
    expect(user.allowedProviders).toEqual(['openai']);
    expect(user.allowedModels).toEqual(['gpt-5']);
    expect(user.monthlyLimitUsd).toBe(20);
    expect(user.maxDots).toBe(3);
    const admin = await auth.createUser(
      'boss',
      'a-strong-password',
      'admin',
      undefined,
      {
        allowedProviders: ['openai'],
        allowedModels: ['gpt-5'],
        monthlyLimitUsd: 20,
        maxDots: 3,
      },
    );
    // Admin = toujours sans restriction (listes forcées à NULL).
    expect(admin.allowedProviders).toBeNull();
    expect(admin.allowedModels).toBeNull();
    expect(admin.monthlyLimitUsd).toBe(20);
    expect(admin.maxDots).toBe(3);
    // listUsers n'expose pas le hash.
    const listed = auth.listUsers();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('passwordHash');
    expect(listed.find((u) => u.username === 'marie')?.allowedModels).toEqual([
      'gpt-5',
    ]);
  });
  it('updateUser : passer à Admin force les listes à NULL', async () => {
    const auth = new AuthStore(':memory:');
    stores.push(auth);
    const user = await auth.createUser(
      'marie',
      'a-strong-password',
      'user',
      undefined,
      {
        allowedProviders: ['openai'],
        allowedModels: ['gpt-5'],
      },
    );
    const promoted = auth.updateUser(user.id, { role: 'admin' });
    expect(promoted?.role).toBe('admin');
    expect(promoted?.allowedProviders).toBeNull();
    expect(promoted?.allowedModels).toBeNull();
    const demoted = auth.updateUser(user.id, {
      role: 'user',
      allowedProviders: ['anthropic'],
      allowedModels: ['claude-sonnet'],
    });
    expect(demoted?.allowedProviders).toEqual(['anthropic']);
  });
  it('deleteUser efface compte + sessions + codes, garde le journal', async () => {
    const auth = new AuthStore(':memory:');
    stores.push(auth);
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const { rawId } = auth.createSession(user.id);
    auth.logAuthEvent('login_ok', 'marie', '127.0.0.1');
    expect(auth.getSession(rawId)).toBeDefined();
    auth.deleteUser(user.id);
    expect(auth.getUserById(user.id)).toBeUndefined();
    expect(auth.getSession(rawId)).toBeUndefined();
    expect(auth.listAuthEvents()).toHaveLength(1);
  });
  it('countAdmins compte les Admins', async () => {
    const auth = new AuthStore(':memory:');
    stores.push(auth);
    await auth.createUser('boss', 'a-strong-password', 'admin');
    await auth.createUser('boss2', 'a-strong-password', 'admin');
    await auth.createUser('marie', 'a-strong-password', 'user');
    expect(auth.countAdmins()).toBe(2);
  });
});

describe('WorkspaceStore — enforcement (Phase E)', () => {
  function fixture() {
    const db = new DatabaseSync(':memory:');
    const records = new Map<
      string,
      {
        role: string;
        allowedProviders: string[] | null;
        allowedModels: string[] | null;
        monthlyLimitUsd: number | null;
        maxDots: number | null;
      }
    >([
      [
        USER,
        {
          role: 'user',
          allowedProviders: ['openai'],
          allowedModels: ['gpt-5'],
          monthlyLimitUsd: 20,
          maxDots: 1,
        },
      ],
      [
        ADMIN,
        {
          role: 'admin',
          allowedProviders: null,
          allowedModels: null,
          monthlyLimitUsd: null,
          maxDots: null,
        },
      ],
    ]);
    const ws = new WorkspaceStore(db, null, {
      getUserRecord: (id) => records.get(id),
    });
    const wsUser = ws.forUser(USER);
    const wsAdmin = ws.forUser(ADMIN);
    const wsOther = ws.forUser(OTHER);
    return { db, ws, wsUser, wsAdmin, wsOther, close: () => db.close() };
  }
  it('maxDots : la création au-delà du max est refusée', () => {
    const { wsUser, close } = fixture();
    try {
      const space = wsUser.createSpace('Atelier', '');
      wsUser.createDot(space.id, 'Dot 1', 'Help', true, true);
      expect(() =>
        wsUser.createDot(space.id, 'Dot 2', 'Help', true, true),
      ).toThrow('Dot limit reached.');
    } finally {
      close();
    }
  });
  it('modèle autorisé : createDot + setDotModel rejettent hors liste', () => {
    const { wsUser, close } = fixture();
    try {
      const space = wsUser.createSpace('Atelier', '');
      expect(() =>
        wsUser.createDot(
          space.id,
          'Dot',
          'Help',
          true,
          true,
          [space.id],
          null,
          false,
          'autre-modele',
        ),
      ).toThrow('not allowed');
      const dot = wsUser.createDot(
        space.id,
        'Dot',
        'Help',
        true,
        true,
        [space.id],
        null,
        false,
        'gpt-5',
      );
      expect(() => wsUser.setDotModel(dot.id, 'anthropic', 'claude')).toThrow(
        'not allowed',
      );
      expect(() =>
        wsUser.setDotModel(dot.id, 'openai', 'autre-modele'),
      ).toThrow('not allowed');
      const updated = wsUser.setDotModel(dot.id, 'openai', 'gpt-5');
      expect(updated.model).toBe('gpt-5');
    } finally {
      close();
    }
  });
  it('Admin = sans restriction ; sans callback = sans restriction', () => {
    const { wsAdmin, close } = fixture();
    try {
      const space = wsAdmin.createSpace('Atelier', '');
      const dot = wsAdmin.createDot(
        space.id,
        'Dot',
        'Help',
        true,
        true,
        [space.id],
        null,
        false,
        'n-importe-quel-modele',
      );
      expect(
        wsAdmin.setDotModel(dot.id, 'n-importe-quel-provider', 'x').model,
      ).toBe('x');
    } finally {
      close();
    }
    const db2 = new DatabaseSync(':memory:');
    try {
      const ws = new WorkspaceStore(db2, USER);
      const space = ws.createSpace('Atelier', '');
      expect(() =>
        ws.createDot(
          space.id,
          'Dot',
          'Help',
          true,
          true,
          [space.id],
          null,
          false,
          'x',
        ),
      ).not.toThrow();
    } finally {
      db2.close();
    }
  });
  it('deleteUserData efface le monde du compte, pas celui des autres', () => {
    const { db, ws, wsUser, wsOther, close } = fixture();
    try {
      const spaceA = wsUser.createSpace('Atelier A', '');
      const dotA = wsUser.createDot(spaceA.id, 'Dot A', 'Help', true, true);
      wsUser.bindThread('t-a', dotA.id, 'Conv A');
      const spaceB = wsOther.createSpace('Atelier B', '');
      const dotB = wsOther.createDot(spaceB.id, 'Dot B', 'Help', true, true);
      wsOther.bindThread('t-b', dotB.id, 'Conv B');
      ws.deleteUserData(USER);
      expect(ws.forUser(USER).spaces()).toHaveLength(0);
      expect(ws.forUser(USER).dots()).toHaveLength(0);
      expect(ws.forUser(USER).conversations()).toHaveLength(0);
      expect(ws.forUser(OTHER).spaces()).toHaveLength(1);
      expect(ws.forUser(OTHER).dots()).toHaveLength(1);
      expect(ws.forUser(OTHER).conversations()).toHaveLength(1);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM thread_bindings').get(),
      ).toEqual({ n: 1 });
    } finally {
      close();
    }
  });
});

describe('Store — coût mensuel + suppression (Phase E)', () => {
  it('monthCostUsd ne compte que le mois en cours', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = new Store(db, USER);
      const now = Date.now();
      store.recordUsage({
        ts: now,
        dotId: 'd1',
        model: 'gpt-5',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 3,
      });
      store.recordUsage({
        ts: now - 40 * 24 * 60 * 60 * 1000,
        dotId: 'd1',
        model: 'gpt-5',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 100,
      });
      expect(store.monthCostUsd(now)).toBe(3);
      const storeOther = new Store(db, OTHER);
      expect(storeOther.monthCostUsd(now)).toBe(0);
    } finally {
      db.close();
    }
  });
  it('attachmentIdsForUser + deleteUserData (Store)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = new Store(db);
      store.claimAttachment('att-1', USER);
      store.claimAttachment('att-2', OTHER);
      expect(store.attachmentIdsForUser(USER)).toEqual(['att-1']);
      const storeUser = new Store(db, USER);
      storeUser.saveMemory('Préférence A.');
      store.deleteUserData(USER);
      expect(store.attachmentIdsForUser(USER)).toEqual([]);
      expect(store.attachmentIdsForUser(OTHER)).toEqual(['att-2']);
      expect(new Store(db, USER).memories()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('SqliteAgentRunner — deleteUserThreads (Phase E)', () => {
  it('efface les threads du compte (DB + mémoire)', () => {
    const path = tempDb();
    const setup = new DatabaseSync(path);
    setup.exec(
      'CREATE TABLE runner_threads (thread_id TEXT PRIMARY KEY, messages TEXT NOT NULL, created_at INTEGER NOT NULL, user_id TEXT);' +
        'CREATE TABLE runner_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT, parent_run_id TEXT, events TEXT NOT NULL, created_at INTEGER NOT NULL, user_id TEXT);' +
        `INSERT INTO runner_threads VALUES ('t-a', '[]', 1, '${USER}');` +
        `INSERT INTO runner_threads VALUES ('t-b', '[]', 1, '${OTHER}');` +
        `INSERT INTO runner_runs (thread_id, run_id, agent_id, parent_run_id, events, created_at, user_id) VALUES ('t-a', 'r1', NULL, NULL, '[]', 1, '${USER}');`,
    );
    setup.close();
    const runner = new SqliteAgentRunner(path);
    try {
      runner.deleteUserThreads(USER);
      const threads = dbOf(runner)
        .prepare('SELECT thread_id FROM runner_threads')
        .all() as Array<{ thread_id: string }>;
      expect(threads).toEqual([{ thread_id: 't-b' }]);
      const runs = dbOf(runner)
        .prepare('SELECT thread_id FROM runner_runs')
        .all() as Array<{ thread_id: string }>;
      expect(runs).toEqual([]);
    } finally {
      runner.close();
    }
  });
});

describe('DotAgent — enforcement (Phase E)', () => {
  function agentFixture(limits: {
    role: string;
    allowedProviders: string[] | null;
    allowedModels: string[] | null;
    monthlyLimitUsd: number | null;
    maxDots: number | null;
  }) {
    const store = new Store(':memory:').forUser('owner');
    const workspace = new WorkspaceStore(':memory:', 'owner', {
      getUserRecord: () => limits,
    });
    workspace.ensureSeed();
    databases.push(store, workspace);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Test');
    const agent = new DotAgent(
      store,
      workspace,
      {
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
      false,
    );
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    return { agent, input, store, workspace };
  }
  const databases: Array<{ close(): void }> = [];
  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    vi.restoreAllMocks();
    inner.configure.mockClear();
  });
  it('limite mensuelle atteinte → RUN_ERROR, le modèle n’est pas appelé', async () => {
    const f = agentFixture({
      role: 'user',
      allowedProviders: null,
      allowedModels: null,
      monthlyLimitUsd: 20,
      maxDots: null,
    });
    f.store.recordUsage({
      ts: Date.now(),
      dotId: null,
      model: 'fixture',
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 25,
    });
    inner.run.mockReturnValue(of());
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      { message?: string } | undefined;
    expect(error?.message).toContain('Monthly usage limit reached.');
    expect(inner.run).not.toHaveBeenCalled();
  });
  it('modèle résolu hors liste → RUN_ERROR', async () => {
    const f = agentFixture({
      role: 'user',
      allowedProviders: null,
      allowedModels: ['gpt-5'],
      monthlyLimitUsd: null,
      maxDots: null,
    });
    inner.run.mockReturnValue(of());
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      { message?: string } | undefined;
    expect(error?.message).toContain('not allowed for this account');
    expect(inner.run).not.toHaveBeenCalled();
  });
});
describe('Routes Admin + filtrage providers (Phase E)', () => {
  const MASTER = 'master-password-123';
  const config: Config = {
    mode: 'sample',
    baseUrl: 'https://api.openai.com/v1',
  };
  function fixture() {
    const db = new DatabaseSync(':memory:');
    const auth = new AuthStore(':memory:');
    stores.push(auth);
    const store = new Store(db);
    const workspace = new WorkspaceStore(db, null, {
      getUserRecord: (id) => auth.getUserById(id) ?? undefined,
    });
    // Registre providers réel (ids : opencode, litellm, openrouter, …).
    const registry = new ProviderRegistry(
      new MemoryConfigStore(),
      'secret',
      {},
    );
    registry.setModels('opencode', ['gpt-5', 'gpt-4o']);
    registry.setModels('litellm', ['claude-sonnet']);
    const platform = new Platform(store, workspace, {
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      providerRegistry: registry,
      providers: registry.list(),
    });
    const runner = new Runner(store, config);
    const app = createApp({ store, runner, config, auth, platform });
    return {
      db,
      auth,
      store,
      workspace,
      platform,
      app,
      close: () => db.close(),
    };
  }
  async function loginAs(
    app: ReturnType<typeof createApp>,
    username: string,
    password: string,
  ) {
    const res = await app.request(
      '/api/auth/login',
      json({ username, password }),
    );
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    return { Cookie: cookie as string };
  }
  it('Admin : liste, création (201), création vide (400), audit', async () => {
    const { app, auth, close } = fixture();
    try {
      await auth.createUser('boss', 'a-strong-password', 'admin');
      const headers = await loginAs(app, 'boss', 'a-strong-password');
      const list = await app.request('/api/auth/users', { headers });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { users: unknown[] }).users).toHaveLength(
        1,
      );
      const created = await app.request(
        '/api/auth/users',
        authJson(
          {
            username: 'marie',
            password: 'a-strong-password',
            role: 'user',
            allowedProviders: ['openai'],
            allowedModels: ['gpt-5'],
            monthlyLimitUsd: 20,
            maxDots: 3,
          },
          headers,
        ),
      );
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        user: { allowedProviders: string[]; maxDots: number };
      };
      expect(body.user.allowedProviders).toEqual(['openai']);
      expect(body.user.maxDots).toBe(3);
      const empty = await app.request(
        '/api/auth/users',
        authJson(
          {
            username: 'vide',
            password: 'a-strong-password',
            role: 'user',
            allowedProviders: [],
            allowedModels: [],
          },
          headers,
        ),
      );
      expect(empty.status).toBe(400);
      const audit = await app.request('/api/auth/audit', { headers });
      expect(audit.status).toBe(200);
      expect(
        (
          (await audit.json()) as { events: Array<{ action: string }> }
        ).events.some((e) => e.action === 'user_created'),
      ).toBe(true);
    } finally {
      close();
    }
  });
  it('Utilisateur : 403 sur les routes Admin + providers/catalog filtrés', async () => {
    const { app, auth, close } = fixture();
    try {
      await auth.createUser('boss', 'a-strong-password', 'admin');
      await auth.createUser('marie', 'a-strong-password', 'user', undefined, {
        allowedProviders: ['opencode'],
        allowedModels: ['gpt-5'],
      });
      const headers = await loginAs(app, 'marie', 'a-strong-password');
      const list = await app.request('/api/auth/users', { headers });
      expect(list.status).toBe(403);
      const providers = await app.request('/api/providers', { headers });
      expect(providers.status).toBe(200);
      const providersBody = (await providers.json()) as {
        providers: Array<{ id: string }>;
      };
      expect(providersBody.providers.map((p) => p.id)).toEqual(['opencode']);
      const catalogForbidden = await app.request('/api/catalog/litellm', {
        headers,
      });
      expect(catalogForbidden.status).toBe(404);
      const catalog = await app.request('/api/catalog/opencode', { headers });
      expect(catalog.status).toBe(200);
      const catalogBody = (await catalog.json()) as {
        models: Array<{ id: string }>;
      };
      expect(catalogBody.models.map((m) => m.id)).toEqual(['gpt-5']);
    } finally {
      close();
    }
  });
  it('PATCH + changement de mot de passe (sessions révoquées)', async () => {
    const { app, auth, close } = fixture();
    try {
      await auth.createUser('boss', 'a-strong-password', 'admin');
      const target = await auth.createUser(
        'marie',
        'a-strong-password',
        'user',
        undefined,
        {
          allowedProviders: ['openai'],
          allowedModels: ['gpt-5'],
        },
      );
      const adminHeaders = await loginAs(app, 'boss', 'a-strong-password');
      const userHeaders = await loginAs(app, 'marie', 'a-strong-password');
      const patched = await app.request(`/api/auth/users/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ maxDots: 5 }),
      });
      expect(patched.status).toBe(200);
      expect(
        ((await patched.json()) as { user: { maxDots: number } }).user.maxDots,
      ).toBe(5);
      const changed = await app.request(
        `/api/auth/users/${target.id}/password`,
        authJson({ password: 'a-new-password-1' }, adminHeaders),
      );
      expect(changed.status).toBe(200);
      // L'ancienne session de marie est révoquée.
      const me = await app.request('/api/auth/me', { headers: userHeaders });
      expect(me.status).toBe(401);
      // Le nouveau mot de passe fonctionne.
      await loginAs(app, 'marie', 'a-new-password-1');
    } finally {
      close();
    }
  });
  it('DELETE : mot de passe maître faux → 401 ; soi-même → 400 ; dernier Admin → 400', async () => {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
    const { app, auth, close } = fixture();
    try {
      const boss = await auth.createUser('boss', 'a-strong-password', 'admin');
      const headers = await loginAs(app, 'boss', 'a-strong-password');
      const wrong = await app.request(`/api/auth/users/${boss.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ masterPassword: 'faux', confirm: true }),
      });
      expect(wrong.status).toBe(401);
    } finally {
      close();
      if (saved === undefined) delete process.env.ADMIN_MASTER_PASSWORD;
      else process.env.ADMIN_MASTER_PASSWORD = saved;
    }
  });
  it('DELETE : soi-même → 400', async () => {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
    const { app, auth, close } = fixture();
    try {
      const boss = await auth.createUser('boss', 'a-strong-password', 'admin');
      const headers = await loginAs(app, 'boss', 'a-strong-password');
      const self = await app.request(`/api/auth/users/${boss.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ masterPassword: MASTER, confirm: true }),
      });
      expect(self.status).toBe(400);
    } finally {
      close();
      if (saved === undefined) delete process.env.ADMIN_MASTER_PASSWORD;
      else process.env.ADMIN_MASTER_PASSWORD = saved;
    }
  });
  it('DELETE : dernier Admin → 400', async () => {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
    const { app, auth, close } = fixture();
    try {
      const boss = await auth.createUser('boss', 'a-strong-password', 'admin');
      const headers = await loginAs(app, 'boss', 'a-strong-password');
      const last = await app.request(`/api/auth/users/${boss.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ masterPassword: MASTER, confirm: true }),
      });
      // boss est son propre compte → 400 (soi-même) ; on vérifie le
      // dernier-Admin via un second Admin qui supprime le premier.
      expect(last.status).toBe(400);
      const boss2 = await auth.createUser(
        'boss2',
        'a-strong-password',
        'admin',
      );
      const headers2 = await loginAs(app, 'boss2', 'a-strong-password');
      const delFirst = await app.request(`/api/auth/users/${boss.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers2 },
        body: JSON.stringify({ masterPassword: MASTER, confirm: true }),
      });
      expect(delFirst.status).toBe(200);
      expect(auth.getUserById(boss.id)).toBeUndefined();
      // boss2 est maintenant le dernier Admin : il ne peut pas se supprimer.
      const delLast = await app.request(`/api/auth/users/${boss2.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers2 },
        body: JSON.stringify({ masterPassword: MASTER, confirm: true }),
      });
      expect(delLast.status).toBe(400);
    } finally {
      close();
      if (saved === undefined) delete process.env.ADMIN_MASTER_PASSWORD;
      else process.env.ADMIN_MASTER_PASSWORD = saved;
    }
  });
  it('DELETE : compte Utilisateur → 200, données effacées (cascade)', async () => {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
    const { app, auth, store, workspace, close } = fixture();
    try {
      await auth.createUser('boss', 'a-strong-password', 'admin');
      const target = await auth.createUser(
        'marie',
        'a-strong-password',
        'user',
        undefined,
        {
          allowedProviders: ['openai'],
          allowedModels: ['gpt-5'],
        },
      );
      // Données du compte à supprimer.
      const wsUser = workspace.forUser(target.id);
      const space = wsUser.createSpace('Atelier', '');
      wsUser.createDot(space.id, 'Dot', 'Help', true, true);
      new Store(storeDbOf(store), target.id).saveMemory('Préférence.');
      const headers = await loginAs(app, 'boss', 'a-strong-password');
      const deleted = await app.request(`/api/auth/users/${target.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ masterPassword: MASTER, confirm: true }),
      });
      expect(deleted.status).toBe(200);
      expect(auth.getUserById(target.id)).toBeUndefined();
      expect(workspace.forUser(target.id).spaces()).toHaveLength(0);
      expect(new Store(storeDbOf(store), target.id).memories()).toHaveLength(0);
      const audit = await app.request('/api/auth/audit', { headers });
      expect(
        (
          (await audit.json()) as { events: Array<{ action: string }> }
        ).events.some((e) => e.action === 'user_deleted'),
      ).toBe(true);
    } finally {
      close();
      if (saved === undefined) delete process.env.ADMIN_MASTER_PASSWORD;
      else process.env.ADMIN_MASTER_PASSWORD = saved;
    }
  });
});
