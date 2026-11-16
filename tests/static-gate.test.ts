import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { createStaticGate } from '../src/server/app.js';

/** Porte du statique : ce qui doit être lisible SANS session (PWA/TWA). */
function gate() {
  const app = new Hono();
  app.use('*', createStaticGate(undefined));
  app.get('*', (c) => c.text('ok'));
  return app;
}

it('sert le manifest, les icônes d’app et assetlinks sans session', async () => {
  const app = gate();
  for (const path of [
    '/manifest.webmanifest',
    '/app-icon-192.png',
    '/app-icon-512.png',
    '/app-icon-maskable-512.png',
    '/.well-known/assetlinks.json',
    '/logo.webp',
    '/health',
  ]) {
    const response = await app.request(path);
    expect(response.status, path).toBe(200);
  }
});

it('bloque toujours le reste sans session', async () => {
  const app = gate();
  const script = await app.request('/assets/index.js', {
    headers: { 'sec-fetch-dest': 'script' },
  });
  expect(script.status).toBe(401);
  const document = await app.request('/conversations');
  expect(document.status).toBe(302);
  expect(document.headers.get('location')).toBe('/login');
});

it('assetlinks.json porte le package Android et une empreinte SHA-256', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync('public/.well-known/assetlinks.json', 'utf8');
  const links = JSON.parse(raw) as Array<{
    relation: string[];
    target: {
      namespace: string;
      package_name: string;
      sha256_cert_fingerprints: string[];
    };
  }>;
  expect(links).toHaveLength(1);
  expect(links[0].relation).toContain(
    'delegate_permission/common.handle_all_urls',
  );
  expect(links[0].target.namespace).toBe('android_app');
  expect(links[0].target.package_name).toBe('pro.neva_ci.nevadots');
  for (const print of links[0].target.sha256_cert_fingerprints) {
    expect(print).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
});
