import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Config } from '../src/server/research.js';
import { FaqDialog } from '../src/client/FaqDialog';
import { initialsOf } from '../src/client/initials';
import { ProfileDialog } from '../src/client/ProfileDialog';

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const MASTER = 'master-password-123';

describe('Phase F — /api/auth/me + menu avatar', () => {
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

  it('/api/auth/me renvoie les limites du compte connecté', async () => {
    const f = fixture();
    stores.push(f);
    await f.auth.createUser('boss', 'a-strong-password', 'admin');
    await f.auth.createUser('marie', 'a-strong-password', 'user', undefined, {
      allowedProviders: ['opencode'],
      allowedModels: ['gpt-5'],
      monthlyLimitUsd: 20,
      maxDots: 3,
    });
    const marie = await loginAs(f.app, 'marie', 'a-strong-password');
    const res = await f.app.request('/api/auth/me', { headers: marie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      username: 'marie',
      role: 'user',
      maxDots: 3,
      monthlyLimitUsd: 20,
      allowedProviders: ['opencode'],
      allowedModels: ['gpt-5'],
    });
    const boss = await loginAs(f.app, 'boss', 'a-strong-password');
    const resBoss = await f.app.request('/api/auth/me', { headers: boss });
    expect(resBoss.status).toBe(200);
    expect(await resBoss.json()).toEqual({
      username: 'boss',
      role: 'admin',
      maxDots: null,
      monthlyLimitUsd: null,
      allowedProviders: null,
      allowedModels: null,
    });
  });
  it('/api/auth/me sans session → 401', async () => {
    const f = fixture();
    stores.push(f);
    const res = await f.app.request('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('FaqDialog affiche les 8 questions validées', () => {
    const html = renderToStaticMarkup(<FaqDialog onClose={() => {}} />);
    for (const q of [
      'C’est quoi un Dot ?',
      'C’est quoi la « Discussion principale » ?',
      'Comment créer un compte ?',
      'J’ai oublié mon mot de passe ?',
      'C’est quoi la limite mensuelle ?',
      'Pourquoi un modèle n’apparaît pas dans mon sélecteur ?',
      'Où sont mes données ?',
      'Comment supprimer mon compte ?',
    ])
      expect(html).toContain(q);
  });
  it('initialsOf : initiales du compte pour l’avatar rond', () => {
    expect(initialsOf('marie')).toBe('MA');
    expect(initialsOf('hajrudin-zelef')).toBe('HZ');
    expect(initialsOf('hajrudin zelef')).toBe('HZ');
    expect(initialsOf('a')).toBe('A');
    expect(initialsOf('')).toBe('•');
  });
  it('ProfileDialog rend le titre + l’état de chargement (sans fetch)', () => {
    const html = renderToStaticMarkup(<ProfileDialog onClose={() => {}} />);
    expect(html).toContain('Profil');
    expect(html).toContain('Chargement');
  });
});
