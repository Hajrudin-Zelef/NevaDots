import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import type { CatalogModel, CreditEntry } from '../shared/models.js';

const CREDIT_TIMEOUT_MS = 8000;

/** Normalizes an OpenAI-compatible `/models` payload into a model list. */
function parseModels(payload: unknown): CatalogModel[] {
  const data =
    (payload as { data?: unknown; models?: unknown })?.data ??
    (payload as { models?: unknown })?.models;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => {
      if (typeof entry === 'string') return { id: entry };
      const id = (entry as { id?: unknown })?.id;
      if (typeof id !== 'string') return null;
      const name = (entry as { name?: unknown })?.name;
      return { id, name: typeof name === 'string' ? name : undefined };
    })
    .filter((model): model is CatalogModel => !!model);
}

async function fetchBalance(
  url: string,
  key: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function providerRoutes(platform: Platform) {
  const app = new Hono();
  const registry = platform.config.providerRegistry;

  app.get('/providers', (c) =>
    c.json({ providers: registry ? registry.view() : [] }),
  );

  app.put('/providers/:id', async (c) => {
    const parsed = z
      .object({ key: z.string().trim().min(1).max(400) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid API key.' }, 400);
    if (!registry?.get(c.req.param('id')))
      return c.json({ error: 'Unknown provider.' }, 404);
    registry.setKey(c.req.param('id'), parsed.data.key);
    return c.json({ providers: registry.view() });
  });

  app.delete('/providers/:id', (c) => {
    if (!registry?.get(c.req.param('id')))
      return c.json({ error: 'Unknown provider.' }, 404);
    registry.deleteKey(c.req.param('id'));
    return c.json({ providers: registry.view() });
  });

  // Live model catalog from the provider's OpenAI-compatible `/models`, with
  // the registry's stored/default list as a fallback.
  app.get('/catalog/:id', async (c) => {
    const provider = registry?.get(c.req.param('id'));
    if (!provider) return c.json({ error: 'Unknown provider.' }, 404);
    const fallback = provider.models.map((id) => ({ id }));
    if (!provider.apiKey)
      return c.json({
        provider: provider.id,
        models: fallback,
        source: 'static' as const,
      });
    try {
      const response = await fetch(
        `${provider.baseUrl.replace(/\/$/, '')}/models`,
        {
          headers: { Authorization: `Bearer ${provider.apiKey}` },
          signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = parseModels(await response.json());
      if (!models.length) throw new Error('Empty model list');
      return c.json({
        provider: provider.id,
        models,
        source: 'live' as const,
      });
    } catch (error) {
      return c.json({
        provider: provider.id,
        models: fallback,
        source: 'static' as const,
        error: error instanceof Error ? error.message : 'Unavailable',
      });
    }
  });

  // The enabled models for a provider (what the per-Dot selector offers).
  app.put('/catalog/:id', async (c) => {
    const parsed = z
      .object({ models: z.array(z.string().trim().min(1).max(160)).max(500) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid model list.' }, 400);
    if (!registry?.get(c.req.param('id')))
      return c.json({ error: 'Unknown provider.' }, 404);
    registry.setModels(c.req.param('id'), [...new Set(parsed.data.models)]);
    return c.json({ providers: registry.view() });
  });

  app.put('/model-default', async (c) => {
    const parsed = z
      .object({
        provider: z.string().trim().min(1).max(40),
        model: z.string().trim().min(1).max(160).nullable(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid default.' }, 400);
    if (!registry?.get(parsed.data.provider))
      return c.json({ error: 'Unknown provider.' }, 404);
    registry.setDefault(parsed.data.provider, parsed.data.model);
    return c.json({ default: registry.effectiveDefault() });
  });

  // Best-effort remaining balance per configured provider.
  app.get('/credits', async (c) => {
    const credits: CreditEntry[] = [];
    for (const provider of registry?.list() ?? []) {
      const entry: CreditEntry = {
        provider: provider.id,
        label: provider.label,
        supported: ['openrouter', 'deepseek', 'freellmapi'].includes(
          provider.id,
        ),
        configured: !!provider.apiKey,
      };
      if (!entry.supported || !provider.apiKey) {
        credits.push(entry);
        continue;
      }
      const signal = AbortSignal.timeout(CREDIT_TIMEOUT_MS);
      try {
        if (provider.id === 'openrouter') {
          const data = (await fetchBalance(
            'https://openrouter.ai/api/v1/credits',
            provider.apiKey,
            signal,
          )) as { data?: { total_credits?: number; total_usage?: number } };
          const total = Number(data.data?.total_credits ?? 0);
          const used = Number(data.data?.total_usage ?? 0);
          entry.balance = Math.max(0, total - used);
          entry.currency = 'USD';
        } else if (provider.id === 'deepseek') {
          const data = (await fetchBalance(
            'https://api.deepseek.com/user/balance',
            provider.apiKey,
            signal,
          )) as {
            balance_infos?: { currency?: string; total_balance?: string }[];
          };
          const info = data.balance_infos?.[0];
          entry.balance = Number(info?.total_balance ?? 0);
          entry.currency = info?.currency ?? 'CNY';
        } else {
          const data = (await fetchBalance(
            `${provider.baseUrl.replace(/\/$/, '')}/billing/usage`,
            provider.apiKey,
            signal,
          )) as { balance?: number; remaining?: number; currency?: string };
          entry.balance = Number(data.balance ?? data.remaining ?? NaN);
          entry.currency = data.currency;
          if (!Number.isFinite(entry.balance)) {
            entry.balance = undefined;
            entry.detail = 'Solde indisponible';
          }
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message : 'Unavailable';
      }
      credits.push(entry);
    }
    return c.json({ credits });
  });

  return app;
}
