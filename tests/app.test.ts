import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { AuthStore } from '../src/server/auth-store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import { resolveAppOrigins } from '../src/server/app-origin.js';
import { loginSession } from './auth-helpers.js';
const stores: { close(): void }[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture(origin?: string | string[]) {
  const store = new Store(':memory:').forUser('owner');
  const auth = new AuthStore(':memory:');
  stores.push(store, auth);
  const runner = new Runner(store, config);
  return {
    store,
    auth,
    runner,
    app: createApp({ store, runner, config, origin, auth }),
  };
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
afterEach(() => stores.splice(0).forEach((store) => store.close()));
describe('API boundaries', () => {
  it('requires a session for state and mutations', async () => {
    const { app, auth } = fixture();
    expect((await app.request('/api/state')).status).toBe(401);
    const cookie = await loginSession(app, auth);
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie } })).status,
    ).toBe(200);
  });
  it('blocks browser cross-origin requests and form posts', async () => {
    const { app, auth } = fixture();
    expect(
      (
        await app.request('/api/tasks', {
          ...json({ prompt: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          },
        })
      ).status,
    ).toBe(403);
    const cookie = await loginSession(app, auth);
    expect(
      (
        await app.request('/api/tasks', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: 'prompt=hello',
        })
      ).status,
    ).toBe(415);
  });
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    'allows a same-origin Vite proxy mutation from %s',
    async (origin) => {
      const { app, auth } = fixture(
        resolveAppOrigins(undefined, 'development'),
      );
      const cookie = await loginSession(app, auth);
      const response = await app.request(`${origin}/api/tasks`, {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          Cookie: cookie,
        },
      });
      expect(response.status).toBe(201);
    },
  );
  it.each([
    'https://evil.example',
    'http://localhost:5174',
    'https://localhost:5173',
  ])(
    'rejects an unlisted origin %s with multiple origins configured',
    async (origin) => {
      const { app } = fixture(resolveAppOrigins(undefined, 'development'));
      const response = await app.request('http://localhost:5173/api/tasks', {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Cross-origin requests are not allowed.',
      });
    },
  );
  it('rejects cross-site requests even from a configured origin', async () => {
    const { app } = fixture(resolveAppOrigins(undefined, 'development'));
    const response = await app.request('http://127.0.0.1:4310/api/tasks', {
      ...json({ prompt: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Cross-site requests are not allowed.',
    });
  });
  it('preserves exact matching for a single configured origin', async () => {
    const { app, auth } = fixture('http://localhost:5173');
    const cookie = await loginSession(app, auth);
    for (const [origin, status] of [
      ['http://localhost:5173', 201],
      ['http://127.0.0.1:5173', 403],
    ] as const) {
      const response = await app.request('http://localhost:5173/api/tasks', {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          Cookie: cookie,
        },
      });
      expect(response.status).toBe(status);
    }
  });
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    'requires session authentication for an allowed origin %s',
    async (origin) => {
      const { app, auth } = fixture(
        resolveAppOrigins(undefined, 'development'),
      );
      const cookie = await loginSession(app, auth);
      for (const [headers, status] of [
        [undefined, 401],
        [{ Cookie: cookie }, 201],
      ] as const) {
        const response = await app.request(`${origin}/api/tasks`, {
          ...json({ prompt: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            'Sec-Fetch-Site': 'same-origin',
            ...headers,
          },
        });
        expect(response.status).toBe(status);
      }
    },
  );
  it('rejects unrecognized hosts even when the origin is explicitly allowed', async () => {
    const { app } = fixture(resolveAppOrigins(undefined, 'development'));
    const response = await app.request('http://attacker.example/api/tasks', {
      ...json({ prompt: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Unrecognized host.' });
  });
  it('does not widen access when an explicit origin list contains only blank entries', async () => {
    const { app } = fixture(resolveAppOrigins(' , ', 'development'));
    const response = await app.request('http://localhost:5173/api/tasks', {
      ...json({ prompt: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(response.status).toBe(403);
  });
  it('requires the request URL origin by default in production', async () => {
    const { app, auth } = fixture(resolveAppOrigins(undefined, 'production'));
    const cookie = await loginSession(app, auth);
    for (const [origin, status] of [
      ['http://localhost:4310', 201],
      ['http://localhost:5173', 403],
    ] as const) {
      const response = await app.request('http://localhost:4310/api/tasks', {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          Cookie: cookie,
        },
      });
      expect(response.status).toBe(status);
    }
  });
  it('validates inputs and enforces research permissions on the server', async () => {
    const { app, store, auth } = fixture();
    const cookie = await loginSession(app, auth);
    const withCookie = (init: RequestInit) => ({
      ...init,
      headers: { ...(init.headers ?? {}), Cookie: cookie },
    });
    expect(
      (await app.request('/api/tasks', withCookie(json({ prompt: 'x' }))))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/tasks',
          withCookie(json({ prompt: 'Research', intervalSeconds: 1 })),
        )
      ).status,
    ).toBe(400);
    store.updateSettings({ researchAllowed: false });
    expect(
      (
        await app.request(
          '/api/tasks',
          withCookie(json({ prompt: 'Research' })),
        )
      ).status,
    ).toBe(403);
    expect(store.claim()).toBeNull();
  });
  it('runs a sample job from the durable queue and retains its result', async () => {
    const { app, store, runner, auth } = fixture();
    const cookie = await loginSession(app, auth);
    const response = await app.request('/api/tasks', {
      ...json({ prompt: 'Plan a quiet weekend' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    expect(response.status).toBe(201);
    await runner.tick();
    const task = store.tasks()[0];
    expect(task.status).toBe('completed');
    expect(store.detail(task.id)?.runs[0].result?.sample).toBe(true);
  });
  it('persists memory edits and deletes', async () => {
    const { app, store, auth } = fixture();
    const cookie = await loginSession(app, auth);
    await app.request('/api/memories', {
      ...json({ text: 'Prefer short briefs' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    const memory = store.memories()[0];
    const updated = await app.request(`/api/memories/${memory.id}`, {
      ...json({ text: 'Prefer deep briefs' }),
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    expect(updated.status).toBe(200);
    expect(store.memories()[0].text).toBe('Prefer deep briefs');
    await app.request(`/api/memories/${memory.id}`, {
      ...json({}),
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    expect(store.memories()).toHaveLength(0);
  });
});
it('rejects DNS-rebinding Host even with a matching hostile Origin', async () => {
  const { app } = fixture();
  const response = await app.request('http://attacker.example/api/tasks', {
    ...json({ prompt: 'Sneaky task' }),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://attacker.example',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  expect(response.status).toBe(403);
});
describe('attachment content auth', () => {
  it('accepte le cookie HttpOnly en GET et sur les autres routes, pas le mauvais cookie', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sandbox = mkdtempSync(join(tmpdir(), 'app-att-'));
    const origCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const { app, auth } = fixture();
      const cookie = await loginSession(app, auth);
      const form = new FormData();
      form.append(
        'files',
        new File(['bonjour'], 'note.txt', { type: 'text/plain' }),
      );
      const up = await app.request('/api/attachments', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: form,
      });
      expect(up.status).toBe(201);
      const { attachments } = (await up.json()) as {
        attachments: { id: string }[];
      };
      const id = attachments[0].id;
      const headers = { headers: { Cookie: cookie } };
      // Lien brut <a href> : 200 grace au cookie.
      expect(
        (await app.request(`/api/attachments/${id}/content`, headers)).status,
      ).toBe(200);
      // Le cookie HttpOnly vaut pour toutes les routes /api (auth générale).
      expect((await app.request('/api/state', headers)).status).toBe(200);
      // Cookie erroné = 401.
      expect(
        (
          await app.request(`/api/attachments/${id}/content`, {
            headers: { Cookie: 'nevadots-session=intrus' },
          })
        ).status,
      ).toBe(401);
    } finally {
      process.chdir(origCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
  it('downgrades a declared image/pdf whose magic bytes do not match', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sandbox = mkdtempSync(join(tmpdir(), 'app-att-'));
    const origCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const { app, auth } = fixture();
      const cookie = await loginSession(app, auth);
      const headers = { Cookie: cookie };
      const upload = async (file: File) => {
        const form = new FormData();
        form.append('files', file);
        const res = await app.request('/api/attachments', {
          method: 'POST',
          headers,
          body: form,
        });
        expect(res.status).toBe(201);
        return (
          (await res.json()) as {
            attachments: { mime: string; category: string }[];
          }
        ).attachments[0];
      };
      // Faux PNG (HTML déguisé) -> dégradé, jamais rejeté.
      expect(
        await upload(
          new File(['<script>alert(1)</script>'], 'fake.png', {
            type: 'image/png',
          }),
        ),
      ).toMatchObject({ mime: 'application/octet-stream', category: 'other' });
      // Vrai PNG (signature minimale) -> conservé.
      expect(
        await upload(
          new File(
            [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
            'real.png',
            { type: 'image/png' },
          ),
        ),
      ).toMatchObject({ mime: 'image/png', category: 'image' });
      // Faux PDF (texte déguisé, extension .pdf) -> dégradé malgré l'extension.
      expect(
        await upload(
          new File(['ceci n est pas un pdf'], 'fake.pdf', {
            type: 'application/pdf',
          }),
        ),
      ).toMatchObject({ mime: 'application/octet-stream', category: 'other' });
      // BMP légitime (signature BM) -> conservé.
      expect(
        await upload(
          new File([Buffer.from('BM')], 'photo.bmp', { type: 'image/bmp' }),
        ),
      ).toMatchObject({ mime: 'image/bmp', category: 'image' });
    } finally {
      process.chdir(origCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('HttpOnly cookie auth', () => {
  // Extrait la paire nevadots-session=<valeur> d'un Set-Cookie.
  const cookieFrom = (res: Response): string | null => {
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return null;
    const pair = setCookie.split(';')[0];
    return pair.startsWith('nevadots-session=') ? pair : null;
  };
  it('sets an HttpOnly SameSite=Strict cookie on correct login', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const res = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('nevadots-session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure'); // http en test
  });
  it('rejects a wrong password without setting a cookie', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const res = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'wrong-password-1' }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('rejects a login without username/password fields', async () => {
    const { app } = fixture();
    const res = await app.request('/api/auth/login', json({}));
    expect(res.status).toBe(400);
  });
  it('authenticates any /api route with the cookie (not just attachments)', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const logged = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = cookieFrom(logged);
    expect(cookie).not.toBeNull();
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie! } }))
        .status,
    ).toBe(200);
    // Sans cookie -> 401.
    expect((await app.request('/api/state')).status).toBe(401);
  });
  it('blocks cookie auth on cross-site requests (CSRF)', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const logged = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = cookieFrom(logged)!;
    // Origin cross-site -> 403.
    expect(
      (
        await app.request('/api/state', {
          headers: { Cookie: cookie, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    // sec-fetch-site cross-site -> 403.
    expect(
      (
        await app.request('/api/state', {
          headers: { Cookie: cookie, 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });
  it('clears the cookie on logout', async () => {
    const { app, auth } = fixture();
    await auth.createUser('marie', 'a-strong-password', 'user');
    const logged = await app.request(
      '/api/auth/login',
      json({ username: 'marie', password: 'a-strong-password' }),
    );
    const cookie = cookieFrom(logged)!;
    const res = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });
});
