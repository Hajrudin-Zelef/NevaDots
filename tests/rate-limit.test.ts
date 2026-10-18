import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import { AuthStore } from '../src/server/auth-store.js';
import { directSession } from './auth-helpers.js';

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const stores: { close(): void }[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  delete process.env.RATE_LIMIT_PER_MIN;
  delete process.env.TRUST_PROXY;
});
// Phase B (comptes) : les requêtes portent le cookie de session — le
// rate-limit est par IP (XFF), la session ne change pas les buckets.
async function fixture() {
  const store = new Store(':memory:');
  const auth = new AuthStore(':memory:');
  stores.push(store, auth);
  const runner = new Runner(store, config);
  const app = createApp({ store, runner, config, auth });
  const cookie = await directSession(auth);
  return { app, cookie };
}

it('rate-limits /api/* per client and allows under the limit', async () => {
  process.env.RATE_LIMIT_PER_MIN = '3';
  process.env.TRUST_PROXY = 'true';
  const { app, cookie } = await fixture();
  const hit = () =>
    app.request('/api/state', {
      headers: { 'x-forwarded-for': '9.9.9.9', Cookie: cookie },
    });
  expect((await hit()).status).toBe(200);
  expect((await hit()).status).toBe(200);
  expect((await hit()).status).toBe(200);
  const blocked = await hit();
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: 'Too many requests.' });
  // A different client is unaffected.
  expect(
    (
      await app.request('/api/state', {
        headers: { 'x-forwarded-for': '8.8.8.8', Cookie: cookie },
      })
    ).status,
  ).toBe(200);
});

it('ignores a forged X-Forwarded-For without TRUST_PROXY', async () => {
  process.env.RATE_LIMIT_PER_MIN = '2';
  const { app, cookie } = await fixture();
  // Each request rotates the forged header; without TRUST_PROXY they all
  // share the socket bucket, so the limit still triggers.
  const hit = (xff: string) =>
    app.request('/api/state', {
      headers: { 'x-forwarded-for': xff, Cookie: cookie },
    });
  expect((await hit('1.1.1.1')).status).toBe(200);
  expect((await hit('2.2.2.2')).status).toBe(200);
  expect((await hit('3.3.3.3')).status).toBe(429);
});

it('RATE_LIMIT_PER_MIN=0 disables the limiter', async () => {
  process.env.RATE_LIMIT_PER_MIN = '0';
  const { app, cookie } = await fixture();
  for (let i = 0; i < 10; i++)
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie } })).status,
    ).toBe(200);
});
