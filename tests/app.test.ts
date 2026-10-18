import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import { resolveAppOrigins } from '../src/server/app-origin.js';
const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture(token?: string, origin?: string | string[]) {
  const store = new Store(':memory:');
  stores.push(store);
  const runner = new Runner(store, config);
  return {
    store,
    runner,
    app: createApp({ store, runner, config, ownerToken: token, origin }),
  };
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
afterEach(() => stores.splice(0).forEach((store) => store.close()));
describe('API boundaries', () => {
  it('requires owner token for state and mutations when configured', async () => {
    const { app } = fixture('private-token');
    expect((await app.request('/api/state')).status).toBe(401);
    expect(
      (
        await app.request('/api/state', {
          headers: { Authorization: 'Bearer private-token' },
        })
      ).status,
    ).toBe(200);
  });
  it('blocks browser cross-origin requests and form posts', async () => {
    const { app } = fixture();
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
    expect(
      (
        await app.request('/api/tasks', {
          method: 'POST',
          body: 'prompt=hello',
        })
      ).status,
    ).toBe(415);
  });
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    'allows a same-origin Vite proxy mutation from %s',
    async (origin) => {
      const { app } = fixture(
        undefined,
        resolveAppOrigins(undefined, 'development'),
      );
      const response = await app.request(`${origin}/api/tasks`, {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
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
      const { app } = fixture(
        undefined,
        resolveAppOrigins(undefined, 'development'),
      );
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
    const { app } = fixture(
      undefined,
      resolveAppOrigins(undefined, 'development'),
    );
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
    const { app } = fixture(undefined, 'http://localhost:5173');
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
        },
      });
      expect(response.status).toBe(status);
    }
  });
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    'requires owner authentication for an allowed origin %s',
    async (origin) => {
      const { app } = fixture(
        'private-token',
        resolveAppOrigins(undefined, 'development'),
      );
      for (const [authorization, status] of [
        [undefined, 401],
        ['Bearer wrong-token', 401],
        ['Bearer private-token', 201],
      ] as const) {
        const response = await app.request(`${origin}/api/tasks`, {
          ...json({ prompt: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            'Sec-Fetch-Site': 'same-origin',
            ...(authorization ? { Authorization: authorization } : {}),
          },
        });
        expect(response.status).toBe(status);
      }
    },
  );
  it('rejects unrecognized hosts even when the origin is explicitly allowed', async () => {
    const { app } = fixture(
      undefined,
      resolveAppOrigins(undefined, 'development'),
    );
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
    const { app } = fixture(undefined, resolveAppOrigins(' , ', 'development'));
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
    const { app } = fixture(
      undefined,
      resolveAppOrigins(undefined, 'production'),
    );
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
        },
      });
      expect(response.status).toBe(status);
    }
  });
  it('validates inputs and enforces research permissions on the server', async () => {
    const { app, store } = fixture();
    expect(
      (await app.request('/api/tasks', json({ prompt: 'x' }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/tasks',
          json({ prompt: 'Research', intervalSeconds: 1 }),
        )
      ).status,
    ).toBe(400);
    store.updateSettings({ researchAllowed: false });
    expect(
      (await app.request('/api/tasks', json({ prompt: 'Research' }))).status,
    ).toBe(403);
    expect(store.claim()).toBeNull();
  });
  it('runs a sample job from the durable queue and retains its result', async () => {
    const { app, store, runner } = fixture();
    const response = await app.request(
      '/api/tasks',
      json({ prompt: 'Plan a quiet weekend' }),
    );
    expect(response.status).toBe(201);
    await runner.tick();
    const task = store.tasks()[0];
    expect(task.status).toBe('completed');
    expect(store.detail(task.id)?.runs[0].result?.sample).toBe(true);
  });
  it('persists memory edits and deletes', async () => {
    const { app, store } = fixture();
    await app.request('/api/memories', json({ text: 'Prefer short briefs' }));
    const memory = store.memories()[0];
    const updated = await app.request(`/api/memories/${memory.id}`, {
      ...json({ text: 'Prefer deep briefs' }),
      method: 'PUT',
    });
    expect(updated.status).toBe(200);
    expect(store.memories()[0].text).toBe('Prefer deep briefs');
    await app.request(`/api/memories/${memory.id}`, {
      ...json({}),
      method: 'DELETE',
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
      const { app } = fixture('private-token');
      const form = new FormData();
      form.append(
        'files',
        new File(['bonjour'], 'note.txt', { type: 'text/plain' }),
      );
      const up = await app.request('/api/attachments', {
        method: 'POST',
        headers: { Authorization: 'Bearer private-token' },
        body: form,
      });
      expect(up.status).toBe(201);
      const { attachments } = (await up.json()) as {
        attachments: { id: string }[];
      };
      const id = attachments[0].id;
      const cookie = { headers: { Cookie: 'opendots-auth=private-token' } };
      // Lien brut <a href> : 200 grace au cookie.
      expect(
        (await app.request(`/api/attachments/${id}/content`, cookie)).status,
      ).toBe(200);
      // Le cookie HttpOnly vaut pour toutes les routes /api (auth générale).
      expect((await app.request('/api/state', cookie)).status).toBe(200);
      // Cookie erroné = 401 (timing-safe).
      expect(
        (
          await app.request(`/api/attachments/${id}/content`, {
            headers: { Cookie: 'opendots-auth=intrus' },
          })
        ).status,
      ).toBe(401);
      // Bearer classique toujours accepté.
      expect(
        (
          await app.request(`/api/attachments/${id}/content`, {
            headers: { Authorization: 'Bearer private-token' },
          })
        ).status,
      ).toBe(200);
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
      const { app } = fixture('private-token');
      const headers = { Authorization: 'Bearer private-token' };
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
  // Extrait la paire opendots-auth=<valeur> d'un Set-Cookie.
  const cookieFrom = (res: Response): string | null => {
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return null;
    const pair = setCookie.split(';')[0];
    return pair.startsWith('opendots-auth=') ? pair : null;
  };
  it('sets an HttpOnly SameSite=Strict cookie on correct login', async () => {
    const { app } = fixture('private-token');
    const res = await app.request(
      '/api/login',
      json({ token: 'private-token' }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('opendots-auth=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure'); // http en test
  });
  it('rejects a wrong token without setting a cookie', async () => {
    const { app } = fixture('private-token');
    const res = await app.request('/api/login', json({ token: 'wrong' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('rejects a login without a token field', async () => {
    const { app } = fixture('private-token');
    const res = await app.request('/api/login', json({}));
    expect(res.status).toBe(400);
  });
  it('authenticates any /api route with the cookie (not just attachments)', async () => {
    const { app } = fixture('private-token');
    const logged = await app.request(
      '/api/login',
      json({ token: 'private-token' }),
    );
    const cookie = cookieFrom(logged);
    expect(cookie).not.toBeNull();
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie! } }))
        .status,
    ).toBe(200);
    // Sans cookie ni header -> 401.
    expect((await app.request('/api/state')).status).toBe(401);
    // L'en-tête Authorization fonctionne toujours (compat API/tests).
    expect(
      (
        await app.request('/api/state', {
          headers: { Authorization: 'Bearer private-token' },
        })
      ).status,
    ).toBe(200);
  });
  it('blocks cookie auth on cross-site requests (CSRF)', async () => {
    const { app } = fixture('private-token');
    const logged = await app.request(
      '/api/login',
      json({ token: 'private-token' }),
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
    const { app } = fixture('private-token');
    const logged = await app.request(
      '/api/login',
      json({ token: 'private-token' }),
    );
    const cookie = cookieFrom(logged)!;
    const res = await app.request('/api/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });
});
