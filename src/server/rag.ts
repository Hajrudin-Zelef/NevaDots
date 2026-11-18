import type { PlatformConfig } from './platform-config.js';

/** Un extrait du corpus renvoyé par `/rag/search`. */
export interface RagHit {
  title: string;
  path: string;
  snippet: string;
}

export interface RagResult {
  covered: boolean;
  corpusVersion: string;
  hits: RagHit[];
}

/** Résultat neutre : corpus non consulté ou question non couverte. */
const EMPTY: RagResult = { covered: false, corpusVersion: 'unknown', hits: [] };

/** Cache court : évite de marteler le service sur une même question. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 100;
const cache = new Map<string, { at: number; result: RagResult }>();

function cacheKey(query: string): string {
  return query.trim().toLowerCase().slice(0, 200);
}

function readCache(key: string): RagResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

function writeCache(key: string, result: RagResult): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), result });
}

/** Vide le cache (tests, changement de corpus). */
export function clearRagCache(): void {
  cache.clear();
}

/**
 * Interroge le corpus distant (websearch_agent, `/rag/search`).
 *
 * Fail-open absolu : service coupé, lent, en erreur ou question non couverte
 * → résultat vide. Le Dot répond alors avec sa connaissance propre ; le corpus
 * est une connaissance supplémentaire, jamais une dépendance.
 */
export async function searchRag(
  query: string,
  config: Pick<PlatformConfig, 'ragUrl' | 'ragKey' | 'ragTimeoutMs'>,
  signal?: AbortSignal,
): Promise<RagResult> {
  const baseUrl = config.ragUrl?.trim();
  const trimmed = query.trim();
  if (!baseUrl || !trimmed || signal?.aborted) return EMPTY;

  const key = cacheKey(trimmed);
  const cached = readCache(key);
  if (cached) return cached;

  const timeoutMs = config.ragTimeoutMs ?? 300;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rag/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.ragKey ? { authorization: `Bearer ${config.ragKey}` } : {}),
      },
      body: JSON.stringify({ query: trimmed.slice(0, 2000), limit: 3 }),
      signal: controller.signal,
    });
    if (!response.ok) return EMPTY;
    const data = (await response.json()) as {
      covered?: unknown;
      corpusVersion?: unknown;
      hits?: unknown;
    };
    const corpusVersion = String(data.corpusVersion ?? 'unknown');
    if (data.covered !== true || !Array.isArray(data.hits)) {
      const result: RagResult = { covered: false, corpusVersion, hits: [] };
      writeCache(key, result);
      return result;
    }
    const hits = (data.hits as Array<Partial<RagHit>>)
      .filter((hit) => hit && typeof hit.snippet === 'string')
      .slice(0, 3)
      .map((hit) => ({
        title: String(hit.title ?? '').slice(0, 200),
        path: String(hit.path ?? '').slice(0, 400),
        snippet: String(hit.snippet ?? '').trim(),
      }))
      .filter((hit) => hit.snippet.length > 0);
    if (!hits.length) {
      const result: RagResult = { covered: false, corpusVersion, hits: [] };
      writeCache(key, result);
      return result;
    }
    const result: RagResult = { covered: true, corpusVersion, hits };
    writeCache(key, result);
    return result;
  } catch {
    // Fail-open : timeout, réseau, JSON invalide — jamais d'erreur au Dot.
    return EMPTY;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
