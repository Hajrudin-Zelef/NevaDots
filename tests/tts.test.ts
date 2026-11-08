import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ProviderRegistry } from '../src/server/providers.js';
import type { Config } from '../src/server/research.js';

/** Mémoire pour ProviderRegistry (même forme que tests/models.test.ts). */
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

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const MASTER = 'master-password-123';

describe('Voix neuronale (/api/tts)', () => {
  function fixture() {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
    const db = new DatabaseSync(':memory:');
    const auth = new AuthStore(':memory:');
    const store = new Store(db);
    const workspace = new WorkspaceStore(db, null, {
      getUserRecord: (id) => auth.getUserById(id) ?? undefined,
    });
    const platform = new Platform(store, workspace, {
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      providerRegistry: new ProviderRegistry(
        new MemoryConfigStore(),
        'secret',
        {},
      ),
    });
    const runner = new Runner(store, config);
    const app = createApp({ store, runner, config, auth, platform });
    return {
      app,
      auth,
      store,
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
    vi.unstubAllGlobals();
  });

  async function loginAs(
    app: ReturnType<typeof fixture>['app'],
    auth: AuthStore,
    username: string,
    role: 'admin' | 'user' = 'user',
  ) {
    if (!auth.getUserByUsername(username))
      await auth.createUser(username, 'a-strong-password', role);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'a-strong-password' }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('nevadots-session='));
    expect(cookie).toBeDefined();
    return { Cookie: cookie as string };
  }

  async function setKey(
    app: ReturnType<typeof fixture>['app'],
    boss: { Cookie: string },
    id: string,
    key: string,
  ) {
    const res = await app.request(`/api/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...boss },
      body: JSON.stringify({ key }),
    });
    expect(res.status).toBe(200);
  }

  it('exige une session, valide le corps', async () => {
    const f = fixture();
    stores.push(f);
    expect(
      (
        await f.app.request('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Bonjour' }),
        })
      ).status,
    ).toBe(401);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    await setKey(f.app, boss, 'opencode', 'sk-test');
    const bad = (body: unknown) =>
      f.app.request('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...boss },
        body: JSON.stringify(body),
      });
    expect((await bad({})).status).toBe(400);
    expect((await bad({ text: '' })).status).toBe(400);
    // Provider inconnu → 404 (pas de repli silencieux).
    expect((await bad({ text: 'Bonjour', provider: 'nope' })).status).toBe(404);
  });

  it('404 sans clé configurée, 400 lisible si le provider refuse', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    const noKey = await f.app.request('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...boss },
      body: JSON.stringify({ text: 'Bonjour', provider: 'opencode' }),
    });
    expect([401, 404]).toContain(noKey.status);
    // Avec clé : catalogue live OK (un modèle TTS), synthèse refusée (401).
    await setKey(f.app, boss, 'opencode', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).endsWith('/models')
          ? Response.json({ data: [{ id: 'tts-1' }] })
          : new Response('ko', { status: 401 }),
      ),
    );
    const refused = await f.app.request('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...boss },
      body: JSON.stringify({
        text: 'Bonjour',
        provider: 'opencode',
        model: 'tts-1',
      }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'refusée',
    );
  });

  it('proxifie l’audio du provider (clé jamais exposée)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    await setKey(f.app, boss, 'opencode', 'sk-test');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let seenAuth = '';
    let seenBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seenAuth = String(
          (init?.headers as Record<string, string>)?.Authorization ?? '',
        );
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }),
    );
    const res = await f.app.request('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...boss },
      body: JSON.stringify({
        text: 'Bonjour le monde',
        provider: 'opencode',
        model: 'tts-1',
        voice: 'nova',
        speed: 1.1,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(seenAuth).toBe('Bearer sk-test');
    expect(seenBody).toMatchObject({
      model: 'tts-1',
      input: 'Bonjour le monde',
      voice: 'nova',
      speed: 1.1,
    });
    // Traçabilité : l'appel est enregistré (modèle tracé, coût inconnu).
    const rows = (
      f.store as unknown as {
        db: { prepare(s: string): { all(): Array<Record<string, unknown>> } };
      }
    ).db
      .prepare('SELECT model, costUsd FROM usage')
      .all();
    expect(rows.some((row) => row.model === 'tts-1')).toBe(true);
  });

  it('GET /tts/models exige un provider explicite (pas de repli)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    const noProvider = await f.app.request('/api/tts/models', {
      headers: boss,
    });
    expect(noProvider.status).toBe(400);
    const unknown = await f.app.request('/api/tts/models?provider=nope', {
      headers: boss,
    });
    expect(unknown.status).toBe(404);
  });

  it('liste les modèles TTS compatibles (live filtré, jamais deviné)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const marie = await loginAs(f.app, f.auth, 'marie');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    // Sans clé : liste vide explicite (pas d'erreur).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    expect(
      (
        (await (
          await f.app.request('/api/tts/models?provider=opencode', {
            headers: marie,
          })
        ).json()) as {
          models: unknown[];
        }
      ).models,
    ).toEqual([]);
    // Catalogue live : TTS gardés, STT exclus.
    await setKey(f.app, boss, 'opencode', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            { id: 'tts-1' },
            { id: 'gpt-4o' },
            { id: 'whisper-1' },
            { id: 'gpt-4o-mini-tts' },
          ],
        }),
      ),
    );
    const live = (await (
      await f.app.request('/api/tts/models?provider=opencode', {
        headers: marie,
      })
    ).json()) as { models: string[]; source: string };
    expect(live.source).toBe('live');
    expect(live.models).toEqual(['tts-1', 'gpt-4o-mini-tts']);
    // Catalogue injoignable : liste vide explicite, rien d'inventé.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ko', { status: 500 })),
    );
    const fallback = (await (
      await f.app.request('/api/tts/models?provider=opencode', {
        headers: marie,
      })
    ).json()) as { models: string[]; source: string; error?: string };
    expect(fallback.source).toBe('none');
    expect(fallback.models).toEqual([]);
    expect(fallback.error).toMatch(/injoignable/);
  });

  it('propage le message d’erreur provider sur 400 (modèle/voix invalide)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    await setKey(f.app, boss, 'opencode', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'Invalid model name passed in model=bogus.' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const res = await f.app.request('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...boss },
      body: JSON.stringify({
        text: 'Bonjour',
        provider: 'opencode',
        model: 'bogus',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'Invalid model name',
    );
  });

  it('Phase E : provider/modèle restreints et plafond mensuel (H1)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    await setKey(f.app, boss, 'opencode', 'sk-test');
    await f.auth.createUser(
      'restreint',
      'a-strong-password',
      'user',
      undefined,
      {
        allowedProviders: ['autre-provider'],
        monthlyLimitUsd: 0,
      },
    );
    const restreint = await loginAs(f.app, f.auth, 'restreint', 'user');
    const post = (session: { Cookie: string }, body: unknown) =>
      f.app.request('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...session },
        body: JSON.stringify(body),
      });
    // Provider hors allowlist → 404 (pas d'énumération).
    expect(
      (await post(restreint, { text: 'Bonjour', provider: 'opencode' })).status,
    ).toBe(404);
    // Catalogue et liste providers filtrés aussi.
    expect(
      (await (
        await f.app.request('/api/tts/models?provider=opencode', {
          headers: restreint,
        })
      ).json()) as { error?: string },
    ).toMatchObject({ error: 'Unknown provider.' });
    const list = (await (
      await f.app.request('/api/tts/providers', { headers: restreint })
    ).json()) as { providers: Array<{ id: string }> };
    expect(list.providers.find((p) => p.id === 'opencode')).toBeUndefined();
    // Plafond mensuel atteint (0 $) → 403 même sur provider autorisé.
    await f.auth.createUser('plafond', 'a-strong-password', 'user', undefined, {
      allowedProviders: ['opencode'],
      monthlyLimitUsd: 0,
    });
    const plafond = await loginAs(f.app, f.auth, 'plafond', 'user');
    expect(
      (
        await post(plafond, {
          text: 'Bonjour',
          provider: 'opencode',
          model: 'tts-1',
        })
      ).status,
    ).toBe(403);
    // Modèle hors allowlist → 403 (fail-closed).
    await f.auth.createUser('partiel', 'a-strong-password', 'user', undefined, {
      allowedProviders: ['opencode'],
      allowedModels: ['chat-seulement'],
    });
    const partiel = await loginAs(f.app, f.auth, 'partiel', 'user');
    expect(
      (
        await post(partiel, {
          text: 'Bonjour',
          provider: 'opencode',
          model: 'tts-1',
        })
      ).status,
    ).toBe(403);
  });

  it('liste les providers configurés (sans clé = absents)', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    await setKey(f.app, boss, 'opencode', 'sk-test');
    const marie = await loginAs(f.app, f.auth, 'marie', 'user');
    const list = (await (
      await f.app.request('/api/tts/providers', { headers: marie })
    ).json()) as {
      providers: Array<{ id: string; label: string; support: string }>;
    };
    const opencode = list.providers.find((p) => p.id === 'opencode');
    expect(opencode).toBeTruthy();
    expect(opencode!.support).toBe('unknown');
  });

  it('PATCH /api/settings valide les champs voix', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const boss = await loginAs(f.app, f.auth, 'boss', 'admin');
    const patch = (body: unknown) =>
      f.app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...boss },
        body: JSON.stringify(body),
      });
    const ok = await patch({
      ttsMode: 'model',
      ttsVoice: 'nova',
      ttsRate: 1.2,
      ttsPauseSentenceMs: 400,
      ttsPauseParagraphMs: 800,
      ttsProvider: 'opencode',
      ttsModel: 'tts-1',
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ttsMode: string }).ttsMode).toBe('model');
    expect((await patch({ ttsMode: 'robot' })).status).toBe(400);
    expect((await patch({ ttsRate: 5 })).status).toBe(400);
    expect((await patch({ ttsPauseSentenceMs: -1 })).status).toBe(400);
    expect((await patch({ pirate: true })).status).toBe(400);
  });
});
