import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { Platform } from '../src/server/platform.js';
import { ProviderRegistry } from '../src/server/providers.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Config } from '../src/server/research.js';

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const authJson = (body: unknown, headers: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const MASTER = 'master-password-123';
/** Extrait la DatabaseSync d'un Store (patron tests/isolation-c2). */
function dbOf(store: object): DatabaseSync {
  return (store as { db: DatabaseSync }).db;
}
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

/**
 * Phase G (durcissement) — intrusion inter-comptes au niveau HTTP.
 * Bob (Utilisateur, providers litellm) tente d'atteindre les données
 * d'Alice (Utilisateur, providers opencode) par TOUTES les familles de
 * routes : ressource d'autrui → 404 (pas d'énumération), routes Admin → 403.
 */
describe('Phase G — intrusion inter-comptes (HTTP)', () => {
  function fixture() {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
    const db = new DatabaseSync(':memory:');
    const auth = new AuthStore(':memory:');
    const store = new Store(db);
    const workspace = new WorkspaceStore(db, null, {
      getUserRecord: (id) => auth.getUserById(id) ?? undefined,
    });
    const registry = new ProviderRegistry(
      new MemoryConfigStore(),
      'secret',
      {},
    );
    registry.setModels('opencode', ['gpt-5']);
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
      app,
      auth,
      store,
      workspace,
      close() {
        db.close();
        auth.close();
        if (saved === undefined) delete process.env.ADMIN_MASTER_PASSWORD;
        else process.env.ADMIN_MASTER_PASSWORD = saved;
      },
    };
  }
  const stores: Array<{ close(): void }> = [];
  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
  });
  async function loginAs(
    app: ReturnType<typeof fixture>['app'],
    username: string,
    password: string,
  ) {
    const res = await app.request(
      '/api/auth/login',
      json({ username, password }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('nevadots-session='));
    expect(cookie).toBeDefined();
    return { Cookie: cookie as string };
  }

  it('Bob ne voit ni ne touche les données d’Alice (404/403 partout)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const alice = await f.auth.createUser(
      'alice',
      'a-strong-password',
      'user',
      'alice-id',
      {
        allowedProviders: ['opencode'],
        allowedModels: ['gpt-5'],
        monthlyLimitUsd: 20,
        maxDots: 3,
      },
    );
    await f.auth.createUser('bob', 'a-strong-password', 'user', 'bob-id', {
      allowedProviders: ['litellm'],
      allowedModels: ['claude-sonnet'],
    });
    // Données d'Alice (monde + page + usage + pièce jointe).
    const wsA = f.workspace.forUser(alice.id);
    const spaceA = wsA.createSpace('Atelier Alice', '');
    const dotA = wsA.createDot(spaceA.id, 'Dot Alice', 'Help', true, true);
    wsA.bindThread('thread-alice', dotA.id, 'Conv Alice');
    const pageA = wsA.pages.create(spaceA.id, {
      title: 'Page Alice',
      content: 'Secret.',
    });
    new Store(dbOf(f.store), alice.id).recordUsage({
      ts: Date.now(),
      dotId: dotA.id,
      model: 'gpt-5',
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 5,
    });
    const headersA = await loginAs(f.app, 'alice', 'a-strong-password');
    const form = new FormData();
    form.append(
      'files',
      new File(['secret'], 'note.txt', { type: 'text/plain' }),
    );
    const up = await f.app.request('/api/attachments', {
      method: 'POST',
      headers: headersA,
      body: form,
    });
    expect(up.status).toBe(201);
    const { attachments } = (await up.json()) as {
      attachments: { id: string }[];
    };
    const attA = attachments[0].id;

    const headersB = await loginAs(f.app, 'bob', 'a-strong-password');

    // Monde : espaces, Dots, duplication.
    expect(
      (
        await f.app.request(`/api/spaces/${spaceA.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...headersB },
          body: JSON.stringify({ name: 'Pirate' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.app.request(`/api/dots/${dotA.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...headersB },
          body: JSON.stringify({
            name: 'Pirate',
            instructions: 'Pirate instructions',
            researchAllowed: true,
            memoryAllowed: true,
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.app.request(`/api/dots/${dotA.id}/duplicate`, {
          method: 'POST',
          headers: headersB,
        })
      ).status,
    ).toBe(404);
    // Le monde de Bob ne contient rien d'Alice — seulement sa graine
    // (ensureSeed au 1er GET /workspace : 1 espace « Everyday » + 1 Dot).
    const wsB = await f.app.request('/api/workspace', { headers: headersB });
    expect(wsB.status).toBe(200);
    const wsBody = (await wsB.json()) as {
      spaces: Array<{ id: string; name: string }>;
      dots: Array<{ id: string; name: string }>;
      conversations: unknown[];
    };
    expect(wsBody.spaces.map((s) => s.id)).not.toContain(spaceA.id);
    expect(wsBody.spaces.map((s) => s.name)).toEqual(['Everyday']);
    expect(wsBody.dots.map((d) => d.id)).not.toContain(dotA.id);
    expect(wsBody.dots.map((d) => d.name)).toEqual(['Dot']);
    expect(wsBody.conversations).toHaveLength(0);

    // Pages : lecture, modification, suppression, liste.
    for (const req of [
      f.app.request(`/api/spaces/${spaceA.id}/pages/${pageA.id}`, {
        headers: headersB,
      }),
      f.app.request(`/api/spaces/${spaceA.id}/pages/${pageA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headersB },
        body: JSON.stringify({ content: 'Pirate', expectedRevision: 1 }),
      }),
      f.app.request(`/api/spaces/${spaceA.id}/pages/${pageA.id}`, {
        method: 'DELETE',
        headers: headersB,
      }),
      f.app.request(`/api/spaces/${spaceA.id}/pages`, { headers: headersB }),
    ])
      expect((await req).status).toBe(404);

    // Pièces jointes : contenu, métadonnées, texte, suppression.
    for (const path of [
      `/api/attachments/${attA}/content`,
      `/api/attachments/${attA}`,
      `/api/attachments/${attA}/text`,
    ])
      expect((await f.app.request(path, { headers: headersB })).status).toBe(
        404,
      );
    expect(
      (
        await f.app.request(`/api/attachments/${attA}`, {
          method: 'DELETE',
          headers: headersB,
        })
      ).status,
    ).toBe(404);

    // Ordinateurs : statut + permissions du Dot d'Alice.
    expect(
      (
        await f.app.request(`/api/dots/${dotA.id}/computer`, {
          headers: headersB,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.app.request(`/api/dots/${dotA.id}/computer/permissions`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headersB },
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
    ).toBe(404);

    // Providers : catalogue d'un provider hors liste → 404 ; liste filtrée.
    expect(
      (await f.app.request('/api/catalog/opencode', { headers: headersB }))
        .status,
    ).toBe(404);
    const providers = await f.app.request('/api/providers', {
      headers: headersB,
    });
    expect(
      (
        (await providers.json()) as { providers: Array<{ id: string }> }
      ).providers.map((p) => p.id),
    ).toEqual(['litellm']);

    // Usage : Bob ne voit pas la consommation d'Alice.
    const usage = await f.app.request('/api/usage', { headers: headersB });
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as {
      today: { costUsd: number };
      week: { costUsd: number };
    };
    expect(usageBody.today.costUsd).toBe(0);
    expect(usageBody.week.costUsd).toBe(0);

    // Routes Admin : 403 (même en lecture, même la suppression).
    expect(
      (await f.app.request('/api/auth/users', { headers: headersB })).status,
    ).toBe(403);
    expect(
      (await f.app.request('/api/auth/audit', { headers: headersB })).status,
    ).toBe(403);
    expect(
      (
        await f.app.request(`/api/auth/users/${alice.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headersB },
          body: JSON.stringify({ maxDots: 99 }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.app.request(`/api/auth/users/${alice.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...headersB },
          body: JSON.stringify({ masterPassword: MASTER, confirm: true }),
        })
      ).status,
    ).toBe(403);

    // Contrôle positif : Bob accède à SES propres données (graine + 1 créé).
    const spaceB = await f.app.request(
      '/api/spaces',
      authJson({ name: 'Atelier Bob' }, headersB),
    );
    expect(spaceB.status).toBe(201);
    const wsB2 = await f.app.request('/api/workspace', { headers: headersB });
    expect(
      (
        (await wsB2.json()) as { spaces: Array<{ id: string; name: string }> }
      ).spaces.map((s) => s.name),
    ).toEqual(['Everyday', 'Atelier Bob']);
  });
});
