import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Config } from '../src/server/research.js';

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const json = (body: unknown, session?: { Cookie: string }) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(session ?? {}),
  },
  body: JSON.stringify(body),
});
const MASTER = 'master-password-123';

describe('POST /api/feedback', () => {
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

  it('enregistre un vote + commentaire, re-vote = mise à jour', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    const res = await f.app.request(
      '/api/feedback',
      json({ messageId: 'm1', vote: -1, comment: 'Trop vague.' }, marie),
    );
    expect(res.status).toBe(201);
    const boss = await (async () => {
      await f.auth.createUser('boss', 'a-strong-password', 'admin');
      return loginAs(f.app, 'boss', 'a-strong-password');
    })();
    const list = await f.app.request('/api/feedback', { headers: boss });
    expect(list.status).toBe(200);
    const first = (await list.json()) as { feedback: unknown[] };
    expect(first.feedback).toHaveLength(1);
    // Re-vote : mise à jour, pas de doublon.
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm1', vote: 1 }, marie),
        )
      ).status,
    ).toBe(201);
    const second = (await (
      await f.app.request('/api/feedback', { headers: boss })
    ).json()) as { feedback: Array<{ vote: number; comment: string | null }> };
    expect(second.feedback).toHaveLength(1);
    expect(second.feedback[0].vote).toBe(1);
  });

  it('lie le vote au modèle réellement servi quand il est connu', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    const marieId = f.auth.getUserByUsername('marie')?.id;
    expect(marieId).toBeTruthy();
    const usage = f.store.forUser(marieId as string);
    // Sans appel modèle : resolvedModel reste null.
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm0', vote: 1, dotId: 'd9' }, marie),
        )
      ).status,
    ).toBe(201);
    // Un appel via openrouter/auto servi par gpt-6-luna (message m1),
    // un autre servi par un autre modèle (message m2).
    usage.recordUsage({
      ts: Date.now(),
      dotId: 'd1',
      model: 'openrouter/auto',
      resolvedModel: 'openai/gpt-6-luna',
      messageId: 'm1',
      promptTokens: 10,
      completionTokens: 2,
      costUsd: null,
    });
    usage.recordUsage({
      ts: Date.now(),
      dotId: 'd1',
      model: 'openrouter/auto',
      resolvedModel: 'autre/modele',
      messageId: 'm2',
      promptTokens: 10,
      completionTokens: 2,
      costUsd: null,
    });
    expect(usage.latestResolvedModel('d1')).toBe('autre/modele');
    expect(usage.latestResolvedModel('d9')).toBeNull();
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm1', vote: -1, dotId: 'd1' }, marie),
        )
      ).status,
    ).toBe(201);
    const boss = await (async () => {
      await f.auth.createUser('boss', 'a-strong-password', 'admin');
      return loginAs(f.app, 'boss', 'a-strong-password');
    })();
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm2', vote: 1, dotId: 'd1' }, marie),
        )
      ).status,
    ).toBe(201);
    const rows = (await (
      await f.app.request('/api/feedback', { headers: boss })
    ).json()) as {
      feedback: Array<{ messageId: string; resolvedModel: string | null }>;
    };
    const votes = new Map(rows.feedback.map((item) => [item.messageId, item]));
    expect(votes.get('m0')?.resolvedModel).toBeNull();
    // F9 : chaque vote porte le modèle de SON message, pas le dernier.
    expect(votes.get('m1')?.resolvedModel).toBe('openai/gpt-6-luna');
    expect(votes.get('m2')?.resolvedModel).toBe('autre/modele');
  });

  it('requiert une session ; la lecture est réservée Admin', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm', vote: 1 }, undefined),
        )
      ).status,
    ).toBe(401);
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    expect(
      (await f.app.request('/api/feedback', { headers: marie })).status,
    ).toBe(403);
    const boss = await loginAs(f.app, 'boss', 'a-strong-password');
    expect(
      (await f.app.request('/api/feedback', { headers: boss })).status,
    ).toBe(200);
  });

  it('rejette les charges invalides', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    expect(
      (await f.app.request('/api/feedback', json({ vote: 1 }, marie))).status,
    ).toBe(400);
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm', vote: 0 }, marie),
        )
      ).status,
    ).toBe(400);
  });

  it("l'auteur retire son vote par messageId, sans toucher aux autres (H3)", async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    await f.auth.createUser('paul', 'a-strong-password', 'user');
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    const paul = await loginAs(f.app, 'paul', 'a-strong-password');
    const boss = await loginAs(f.app, 'boss', 'a-strong-password');
    // Sans session → 401.
    expect(
      (
        await f.app.request('/api/feedback/by-message/m1', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm1', vote: -1 }, marie),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await f.app.request(
          '/api/feedback',
          json({ messageId: 'm1', vote: 1 }, paul),
        )
      ).status,
    ).toBe(201);
    // Marie retire : son vote disparaît, celui de Paul reste.
    expect(
      (
        await f.app.request('/api/feedback/by-message/m1', {
          method: 'DELETE',
          headers: marie,
        })
      ).status,
    ).toBe(200);
    const list = (await (
      await f.app.request('/api/feedback', { headers: boss })
    ).json()) as { feedback: Array<{ messageId: string; username: string }> };
    expect(list.feedback).toHaveLength(1);
    expect(list.feedback[0].username).toBe('paul');
    // Second retrait → 404 (déjà parti).
    expect(
      (
        await f.app.request('/api/feedback/by-message/m1', {
          method: 'DELETE',
          headers: marie,
        })
      ).status,
    ).toBe(404);
  });

  it('suppression admin', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('marie', 'a-strong-password', 'user');
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    await f.app.request(
      '/api/feedback',
      json({ messageId: 'm9', vote: -1 }, marie),
    );
    const boss = await loginAs(f.app, 'boss', 'a-strong-password');
    const listed = (await (
      await f.app.request('/api/feedback', { headers: boss })
    ).json()) as { feedback: Array<{ id: string }> };
    expect(listed.feedback).toHaveLength(1);
    expect(
      (
        await f.app.request(`/api/feedback/${listed.feedback[0].id}`, {
          method: 'DELETE',
          headers: boss,
        })
      ).status,
    ).toBe(200);
    const after = (await (
      await f.app.request('/api/feedback', { headers: boss })
    ).json()) as { feedback: unknown[] };
    expect(after.feedback).toHaveLength(0);
  });
});
