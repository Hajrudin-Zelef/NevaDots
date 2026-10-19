import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import type { AppVariables } from './request-context.js';
import type { CatalogModel, CreditEntry } from '../shared/models.js';

const CREDIT_TIMEOUT_MS = 8000;

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CACHE_TTL_MS = 3_600_000; // 1 h, like cetas-lite's orCache

let openRouterCache: { at: number; models: CatalogModel[] } | null = null;

/** Manufacturer label from a model id prefix (`meta-llama/llama-4` -> `Meta`). */
function makerLabel(id: string): string {
  const prefix = id.split('/')[0]?.trim() || id;
  const known: Record<string, string> = {
    'meta-llama': 'Meta',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    mistralai: 'Mistral',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    xai: 'xAI',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    liquid: 'Liquid',
    nvidia: 'NVIDIA',
    tngtech: 'TNG',
    nousresearch: 'NousResearch',
  };
  const hit = known[prefix.toLowerCase()];
  if (hit) return hit;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

interface OpenRouterModelEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
}

/**
 * Public OpenRouter catalog (no API key needed), projected to CatalogModel
 * with pricing, modality, context length and description. Cached in memory
 * for OPENROUTER_CACHE_TTL_MS; `refresh` bypasses the cache.
 */
async function fetchOpenRouterCatalog(
  refresh: boolean,
): Promise<CatalogModel[]> {
  if (
    !refresh &&
    openRouterCache &&
    Date.now() - openRouterCache.at < OPENROUTER_CACHE_TTL_MS
  )
    return openRouterCache.models;
  const response = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: unknown };
  const data = Array.isArray(payload.data) ? payload.data : [];
  const models: CatalogModel[] = [];
  for (const raw of data) {
    const entry = raw as OpenRouterModelEntry;
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    const arch = entry.architecture ?? {};
    const inMod = Array.isArray(arch.input_modalities)
      ? arch.input_modalities
      : [];
    const outMod = Array.isArray(arch.output_modalities)
      ? arch.output_modalities
      : [];
    const modalities = [...inMod, ...outMod].map(String);
    const prompt = toFiniteNumber(entry.pricing?.prompt);
    const completion = toFiniteNumber(entry.pricing?.completion);
    models.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      description:
        typeof entry.description === 'string' ? entry.description : undefined,
      contextLength: toFiniteNumber(entry.context_length),
      promptPer1M: prompt === undefined ? undefined : prompt * 1_000_000,
      completionPer1M:
        completion === undefined ? undefined : completion * 1_000_000,
      isImage: modalities.includes('image') ? true : undefined,
      maker: makerLabel(entry.id),
    });
  }
  if (!models.length) throw new Error('Empty model list');
  openRouterCache = { at: Date.now(), models };
  return models;
}

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
  const app = new Hono<{ Variables: AppVariables }>();
  const registry = platform.config.providerRegistry;
  /**
   * C3 — les clés des modèles sont GLOBALES (partagées par tous les
   * comptes) : seules les mutations (clés, modèles activés, défaut) et
   * la lecture des soldes (/credits, info financière) sont réservées
   * Admin. Les lectures GET /providers et GET /catalog/:id restent
   * ouvertes à tout compte connecté (le sélecteur de modèles en a
   * besoin).
   * Phase E — les lectures sont FILTRÉES par compte : un Utilisateur
   * restreint ne voit que ses providers / modèles autorisés (Admin =
   * tout). Un provider hors liste répond 404 (pas d'énumération).
   */
  const allowedFor = (c: Context<{ Variables: AppVariables }>) =>
    platform.workspace.forUser(c.get('userId')).userLimits();
  const requireAdmin = (c: Context<{ Variables: AppVariables }>) =>
    c.get('role') !== 'admin' ? c.json({ error: 'Admin only.' }, 403) : null;

  app.get('/providers', (c) => {
    const providers = registry ? registry.view() : [];
    const limits = allowedFor(c);
    if (!limits?.allowedProviders) return c.json({ providers });
    return c.json({
      providers: providers.filter((provider) =>
        limits.allowedProviders!.includes(provider.id),
      ),
    });
  });

  app.put('/providers/:id', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
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
    const denied = requireAdmin(c);
    if (denied) return denied;
    if (!registry?.get(c.req.param('id')))
      return c.json({ error: 'Unknown provider.' }, 404);
    registry.deleteKey(c.req.param('id'));
    return c.json({ providers: registry.view() });
  });

  // Live model catalog. OpenRouter prefers its public catalog (no key needed,
  // enriched with pricing / modality / context); other providers use their
  // OpenAI-compatible `/models` when a key is set, else the stored list.
  // `?refresh=1` bypasses the OpenRouter cache.
  app.get('/catalog/:id', async (c) => {
    const provider = registry?.get(c.req.param('id'));
    if (!provider) return c.json({ error: 'Unknown provider.' }, 404);
    // Phase E : provider hors liste autorisée → 404 (pas d'énumération).
    const limits = allowedFor(c);
    if (
      limits?.allowedProviders &&
      !limits.allowedProviders.includes(provider.id)
    )
      return c.json({ error: 'Unknown provider.' }, 404);
    const filterModels = (models: CatalogModel[]) =>
      limits?.allowedModels
        ? models.filter((model) => limits.allowedModels!.includes(model.id))
        : models;
    const refresh = c.req.query('refresh') === '1';
    const fallback: CatalogModel[] = provider.models.map((id) => ({
      id,
      maker: makerLabel(id),
    }));
    if (provider.id === 'openrouter') {
      try {
        const models = await fetchOpenRouterCatalog(refresh);
        return c.json({
          provider: provider.id,
          models: filterModels(models),
          source: 'live' as const,
        });
      } catch {
        /* fall through to the keyed/static path below */
      }
    }
    if (!provider.apiKey)
      return c.json({
        provider: provider.id,
        models: filterModels(fallback),
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
      const models = parseModels(await response.json()).map((model) => ({
        ...model,
        maker: makerLabel(model.id),
      }));
      if (!models.length) throw new Error('Empty model list');
      return c.json({
        provider: provider.id,
        models: filterModels(models),
        source: 'live' as const,
      });
    } catch (error) {
      return c.json({
        provider: provider.id,
        models: filterModels(fallback),
        source: 'static' as const,
        error: error instanceof Error ? error.message : 'Unavailable',
      });
    }
  });

  // The enabled models for a provider (what the per-Dot selector offers).
  app.put('/catalog/:id', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
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
    const denied = requireAdmin(c);
    if (denied) return denied;
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
    const denied = requireAdmin(c);
    if (denied) return denied;
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
