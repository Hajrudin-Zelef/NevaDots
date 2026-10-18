import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import {
  AuthStore,
  PASSWORD_MIN_LENGTH,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  hashPassword,
  resolveAdminMasterPassword,
  verifyPassword,
  verifyPasswordOrDummy,
} from '../src/server/auth-store.js';

// Phase A (comptes) : fondations auth — utilisateurs, sessions révoquables,
// codes reset à usage unique, audit. L'auth par jeton coexiste (non branchée).
const stores: { close(): void }[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture() {
  const store = new Store(':memory:');
  const auth = new AuthStore(':memory:');
  stores.push(store, auth);
  const runner = new Runner(store, config);
  return {
    store,
    auth,
    runner,
    app: createApp({ store, runner, config, auth }),
  };
}
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith('nevadots-session='));

describe('password hashing (argon2id)', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct-horse-123');
    expect(await verifyPassword('correct-horse-123', hash)).toBe(true);
    expect(await verifyPassword('wrong-password-12', hash)).toBe(false);
  });
  it('salts every hash (same password → different hashes)', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(
      await hashPassword('same-password-1'),
    );
  });
  it('timing-safe dummy: unknown user costs a real verify, returns false', async () => {
    expect(await verifyPasswordOrDummy('whatever-12345', null)).toBe(false);
  });
});

describe('users (AuthStore)', () => {
  it('creates and retrieves a user (no password hash exposed via User)', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    expect(user.username).toBe('marie');
    expect(user.role).toBe('user');
    expect(user.disabled).toBe(false);
    expect('passwordHash' in user).toBe(false);
    const row = auth.getUserByUsername('marie');
    expect(row?.username).toBe('marie');
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
  });
  it('rejects a duplicate username', async () => {
    const { auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    await expect(
      auth.createUser('marie', 'another-password', 'user'),
    ).rejects.toThrow(/already exists/);
  });
  it(`rejects a password shorter than ${PASSWORD_MIN_LENGTH}`, async () => {
    const { auth } = fixture();
    await expect(auth.createUser('marie', 'short', 'user')).rejects.toThrow(
      /Password/,
    );
  });
  it('disable + role change stick', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    auth.setUserDisabled(user.id, true);
    auth.setUserRole(user.id, 'admin');
    const row = auth.getUserByUsername('marie');
    expect(row?.disabled).toBe(true);
    expect(row?.role).toBe('admin');
  });
});

describe('sessions (AuthStore)', () => {
  it('create → get → revoke → gone', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const { rawId } = auth.createSession(user.id);
    expect(auth.getSession(rawId)?.userId).toBe(user.id);
    auth.revokeSession(rawId);
    expect(auth.getSession(rawId)).toBeUndefined();
  });
  it('unknown raw id → undefined (the DB only holds hashes)', async () => {
    const { auth } = fixture();
    expect(auth.getSession('00'.repeat(32))).toBeUndefined();
  });
  it('expires after 7 days absolute, and after 24 h idle', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const t0 = Date.now();
    const { rawId } = auth.createSession(user.id, t0);
    expect(auth.getSession(rawId, t0 + SESSION_MAX_MS + 1)).toBeUndefined();
    const { rawId: idle } = auth.createSession(user.id, t0);
    expect(auth.getSession(idle, t0 + SESSION_IDLE_MS + 1)).toBeUndefined();
  });
  it('revokeAllSessions + sweepExpiredSessions', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const t0 = Date.now();
    const { rawId: old } = auth.createSession(user.id, t0);
    const { rawId: fresh } = auth.createSession(user.id, t0);
    expect(auth.sweepExpiredSessions(t0 + SESSION_MAX_MS + 1)).toBe(2);
    expect(auth.getSession(old, t0 + SESSION_MAX_MS + 2)).toBeUndefined();
    expect(auth.getSession(fresh, t0 + SESSION_MAX_MS + 2)).toBeUndefined();
    const { rawId: again } = auth.createSession(user.id, t0);
    auth.revokeAllSessions(user.id);
    expect(auth.getSession(again, t0)).toBeUndefined();
  });
});

describe('password resets (AuthStore)', () => {
  it('setUserPassword changes the password (old fails, new works)', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    await auth.setUserPassword(user.id, 'a-brand-new-pass');
    const row = auth.getUserByUsername('marie');
    expect(await verifyPassword('a-brand-new-pass', row!.passwordHash)).toBe(
      true,
    );
    expect(await verifyPassword('a-strong-password', row!.passwordHash)).toBe(
      false,
    );
  });
  it('sweepExpiredResets purges expired codes only', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const t0 = Date.now();
    const { rawToken: old } = auth.createPasswordReset(user.id, t0);
    const { rawToken: fresh } = auth.createPasswordReset(
      user.id,
      t0 + 60 * 60 * 1000,
    );
    expect(auth.sweepExpiredResets(t0 + 60 * 60 * 1000 + 1)).toBe(1);
    expect(auth.verifyPasswordReset(old, t0 + 60 * 60 * 1000 + 2)).toBe(
      undefined,
    );
    expect(
      auth.verifyPasswordReset(fresh, t0 + 60 * 60 * 1000 + 2)?.userId,
    ).toBe(user.id);
  });
  it('create → verify → consume → gone; wrong token fails', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const { rawToken } = auth.createPasswordReset(user.id);
    expect(auth.verifyPasswordReset(rawToken)?.userId).toBe(user.id);
    expect(auth.verifyPasswordReset('00'.repeat(32))).toBeUndefined();
    auth.consumePasswordReset(rawToken);
    expect(auth.verifyPasswordReset(rawToken)).toBeUndefined();
  });
  it('expires after 1 h', async () => {
    const { auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const t0 = Date.now();
    const { rawToken } = auth.createPasswordReset(user.id, t0);
    expect(auth.verifyPasswordReset(rawToken, t0 + 60 * 60 * 1000 + 1)).toBe(
      undefined,
    );
  });
});

describe('auth audit', () => {
  it('logs and lists events (no sensitive data)', async () => {
    const { auth } = fixture();
    auth.logAuthEvent('login_failed', 'marie', '127.0.0.1');
    const events = auth.listAuthEvents();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('login_failed');
    expect(events[0].username).toBe('marie');
    expect(JSON.stringify(events[0])).not.toContain('password');
  });
});

describe('ADMIN_MASTER_PASSWORD', () => {
  it('resolves when set, throws when missing (fail-closed)', () => {
    const saved = process.env.ADMIN_MASTER_PASSWORD;
    try {
      process.env.ADMIN_MASTER_PASSWORD = 'master-secret-123';
      expect(resolveAdminMasterPassword()).toBe('master-secret-123');
      delete process.env.ADMIN_MASTER_PASSWORD;
      expect(() => resolveAdminMasterPassword()).toThrow(
        /ADMIN_MASTER_PASSWORD/,
      );
    } finally {
      if (saved === undefined) delete process.env.ADMIN_MASTER_PASSWORD;
      else process.env.ADMIN_MASTER_PASSWORD = saved;
    }
  });
});

describe('POST /api/auth/login + /api/auth/logout', () => {
  it('login OK → 200 + session cookie HttpOnly/SameSite=Strict/Path=/', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const res = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ username: 'marie', role: 'user' });
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/);
  });
  it('wrong password, unknown user, disabled user → same generic 401', async () => {
    const { app, auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    for (const body of [
      { username: 'marie', password: 'wrong-password-1' },
      { username: 'nobody', password: 'wrong-password-1' },
    ]) {
      const res = await app.request('/api/auth/login', json(body));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Invalid username or password.');
      expect(sessionCookie(res)).toBeUndefined();
    }
    auth.setUserDisabled(user.id, true);
    const res = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid username or password.');
  });
  it('malformed body → 400', async () => {
    const { app } = fixture();
    expect(
      (await app.request('/api/auth/login', json({ username: 'marie' })))
        .status,
    ).toBe(400);
  });
  it('logout revokes the session + clears the cookie; idempotent without cookie', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const login = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = sessionCookie(login)!;
    const raw = cookie.split(';')[0].split('=')[1];
    expect(auth.getSession(decodeURIComponent(raw))).toBeDefined();
    const logout = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);
    expect(
      logout.headers
        .getSetCookie()
        .find((c) => c.startsWith('nevadots-session=')),
    ).toMatch(/Max-Age=0/);
    expect(auth.getSession(decodeURIComponent(raw))).toBeUndefined();
    const again = await app.request('/api/auth/logout', { method: 'POST' });
    expect(again.status).toBe(200);
  });
  it('login rate-limit: 6th attempt in a minute → 429', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/api/auth/login',
        json({ username: 'marie', password: 'wrong-password-1' }),
      );
      expect(res.status).toBe(401);
    }
    const res = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'wrong-password-1' }),
    );
    expect(res.status).toBe(429);
  });
  it('audit: login failures are logged', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'wrong-password-1' }),
    );
    await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const actions = auth.listAuthEvents().map((e) => e.action);
    expect(actions).toContain('login_failed');
    expect(actions).toContain('login_ok');
  });
  it('token flow is gone: POST /api/login → 404 (with a session), Bearer header → 401', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const login = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = sessionCookie(login)!;
    // Avec une session valide, la route /api/login n'existe plus → 404.
    expect(
      (
        await app.request('/api/login', {
          ...json({ token: 'whatever' }),
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request('/api/state', {
          headers: { Authorization: 'Bearer whatever' },
        })
      ).status,
    ).toBe(401);
  });
});

describe('Phase B — POST /api/auth/reset', () => {
  it('valid code → password changed, code consumed, sessions revoked', async () => {
    const { app, auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const login = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = sessionCookie(login)!;
    const raw = cookie.split(';')[0].split('=')[1];
    expect(auth.getSession(decodeURIComponent(raw))).toBeDefined();
    const { rawToken } = auth.createPasswordReset(user.id);
    const reset = await app.request(
      '/api/auth/reset',
      json({ token: rawToken, password: 'a-brand-new-pass' }),
    );
    expect(reset.status).toBe(200);
    // Code consommé (usage unique) + session révoquée.
    expect(auth.verifyPasswordReset(rawToken)).toBeUndefined();
    expect(auth.getSession(decodeURIComponent(raw))).toBeUndefined();
    // Ancien mot de passe KO, nouveau OK.
    expect(
      (
        await app.request(
          '/api/auth/login',
          json({ username: 'marie', password: 'a-strong-password' }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/auth/login',
          json({ username: 'marie', password: 'a-brand-new-pass' }),
        )
      ).status,
    ).toBe(200);
  });
  it('wrong or expired code → 401, password unchanged', async () => {
    const { app, auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    expect(
      (
        await app.request(
          '/api/auth/reset',
          json({ token: '00'.repeat(32), password: 'a-brand-new-pass' }),
        )
      ).status,
    ).toBe(401);
    const t0 = Date.now();
    const { rawToken } = auth.createPasswordReset(user.id, t0);
    // Expire le code en avançant le temps via un sweep, puis reset → 401.
    auth.sweepExpiredResets(t0 + 60 * 60 * 1000 + 1);
    expect(
      (
        await app.request(
          '/api/auth/reset',
          json({ token: rawToken, password: 'a-brand-new-pass' }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/auth/login',
          json({ username: 'marie', password: 'a-strong-password' }),
        )
      ).status,
    ).toBe(200);
  });
  it('reset form (urlencoded) → redirect /login?reset=1', async () => {
    const { app, auth } = fixture();
    const user = await auth.createUser('marie', 'a-strong-password', 'user');
    const { rawToken } = auth.createPasswordReset(user.id);
    const res = await app.request('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(rawToken)}&password=${encodeURIComponent('a-brand-new-pass')}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?reset=1');
  });
});

describe('Phase B — GET /api/auth/me', () => {
  it('with a session → 200 {username, role}; without → 401', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'admin');
    const login = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = sessionCookie(login)!;
    const me = await app.request('/api/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ username: 'marie', role: 'admin' });
    expect((await app.request('/api/auth/me')).status).toBe(401);
  });
});

describe('Phase B — pages /login et /reset', () => {
  it('GET /login → 200 HTML autonome (formulaire, pas de /assets/*, CSP stricte)', async () => {
    const { app } = fixture();
    const res = await app.request('/login');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(
      /default-src 'none'/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<form action="/api/auth/login" method="post">');
    expect(html).toContain('Mot de passe oublié');
    expect(html).not.toContain('/assets/');
    expect(html).not.toContain('<script');
  });
  it('GET /reset → 200 HTML autonome (formulaire code + nouveau mot de passe)', async () => {
    const { app } = fixture();
    const res = await app.request('/reset');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form action="/api/auth/reset" method="post">');
    expect(html).toContain('name="token"');
    expect(html).not.toContain('<script');
  });
  it('GET /login avec une session → redirection vers /', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const login = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const res = await app.request('/login', {
      headers: { Cookie: sessionCookie(login)! },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });
  it('login par formulaire (urlencoded) → cookie + redirection vers /', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=marie&password=a-strong-password',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(sessionCookie(res)).toMatch(/HttpOnly/);
  });
  it('login par formulaire avec mauvais mot de passe → redirection /login?error=1', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=marie&password=wrong-password-1',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=1');
  });
});

describe('Phase B — POST /api/auth/bootstrap', () => {
  const MASTER = 'test-master-password';
  const setMaster = () => {
    process.env.ADMIN_MASTER_PASSWORD = MASTER;
  };
  const clearMaster = () => {
    delete process.env.ADMIN_MASTER_PASSWORD;
  };
  it('wrong master password → 401, no account created', async () => {
    setMaster();
    const { app, auth } = fixture();
    try {
      const res = await app.request(
        '/api/auth/bootstrap',
        json({
          masterPassword: 'wrong-master-password',
          username: 'admin',
          password: 'a-strong-password',
        }),
      );
      expect(res.status).toBe(401);
      expect(auth.countUsers()).toBe(0);
    } finally {
      clearMaster();
    }
  });
  it('correct master + no users → 201, first Admin created; second bootstrap → 409', async () => {
    setMaster();
    const { app, auth } = fixture();
    try {
      const res = await app.request(
        '/api/auth/bootstrap',
        json({
          masterPassword: MASTER,
          username: 'admin',
          password: 'a-strong-password',
        }),
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        ok: true,
        user: { username: 'admin', role: 'admin' },
      });
      expect(auth.countUsers()).toBe(1);
      expect(auth.getUserByUsername('admin')?.role).toBe('admin');
      const again = await app.request(
        '/api/auth/bootstrap',
        json({
          masterPassword: MASTER,
          username: 'second',
          password: 'a-strong-password',
        }),
      );
      expect(again.status).toBe(409);
      expect(auth.countUsers()).toBe(1);
    } finally {
      clearMaster();
    }
  });
  it('bootstrap form (urlencoded) → redirect /login?bootstrap=1', async () => {
    setMaster();
    const { app, auth } = fixture();
    try {
      const res = await app.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `masterPassword=${encodeURIComponent(MASTER)}&username=admin&password=a-strong-password`,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?bootstrap=1');
      expect(auth.countUsers()).toBe(1);
    } finally {
      clearMaster();
    }
  });
  it('GET /bootstrap → 200 form when no users, redirect /login when a user exists', async () => {
    const { app, auth } = fixture();
    const empty = await app.request('/bootstrap');
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain(
      '<form action="/api/auth/bootstrap" method="post">',
    );
    await auth.createUser('admin', 'a-strong-password', 'admin');
    const full = await app.request('/bootstrap');
    expect(full.status).toBe(302);
    expect(full.headers.get('location')).toBe('/login');
  });
});

describe('POST /api/auth/login + /api/auth/logout', () => {
  it('/api/auth/* → 503 without an auth store', async () => {
    const store = new Store(':memory:');
    stores.push(store);
    const runner = new Runner(store, config);
    const bare = createApp({ store, runner, config });
    expect(
      (
        await bare.request(
          '/api/auth/login',
          json({ username: 'x', password: 'y' }),
        )
      ).status,
    ).toBe(503);
    expect(
      (await bare.request('/api/auth/logout', { method: 'POST' })).status,
    ).toBe(503);
  });
});
