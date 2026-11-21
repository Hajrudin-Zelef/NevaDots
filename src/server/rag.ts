import type { PlatformConfig } from './platform-config.js';

/** Un extrait du corpus renvoyé par `/rag/search`. */
export interface RagHit {
  title: string;
  path: string;
  snippet: string;
  /** Date de publication (YYYY-MM-DD) quand la fiche en porte une. */
  dates?: string;
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

const TAG = '[corpus]';

function short(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 87)}…` : one;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

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
 *
 * Chaque échec est **journalisé** (`[corpus]` dans le journal systemd) : aucun
 * échec silencieux. La clé `RAG_KEY` n'est jamais écrite dans les logs.
 */
export async function searchRag(
  query: string,
  config: Pick<PlatformConfig, 'ragUrl' | 'ragKey' | 'ragTimeoutMs'>,
  signal?: AbortSignal,
): Promise<RagResult> {
  const baseUrl = config.ragUrl?.trim();
  const trimmed = query.trim();
  if (!baseUrl) {
    console.debug(`${TAG} non configuré (RAG_URL vide) — question ignorée`);
    return EMPTY;
  }
  if (!trimmed) {
    console.debug(`${TAG} question vide — ignorée`);
    return EMPTY;
  }
  if (signal?.aborted) {
    console.debug(`${TAG} tour déjà annulé avant la pré-recherche`);
    return EMPTY;
  }

  const key = cacheKey(trimmed);
  const cached = readCache(key);
  if (cached) {
    console.debug(
      `${TAG} cache: "${short(trimmed)}" → couvert=${cached.covered} (${cached.hits.length} extrait(s))`,
    );
    return cached;
  }

  const timeoutMs = config.ragTimeoutMs ?? 300;
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
    const elapsed = Date.now() - startedAt;
    if (!response.ok) {
      console.warn(
        `${TAG} HTTP ${response.status} sur /rag/search après ${elapsed} ms — "${short(trimmed)}"`,
      );
      return EMPTY;
    }
    let data: {
      covered?: unknown;
      corpusVersion?: unknown;
      hits?: unknown;
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      console.warn(
        `${TAG} réponse JSON invalide après ${elapsed} ms: ${errorMessage(error)} — "${short(trimmed)}"`,
      );
      return EMPTY;
    }
    const corpusVersion = String(data.corpusVersion ?? 'unknown');
    if (data.covered === false) {
      console.info(
        `${TAG} non couvert en ${elapsed} ms (version ${corpusVersion}) — "${short(trimmed)}"`,
      );
      const result: RagResult = { covered: false, corpusVersion, hits: [] };
      writeCache(key, result);
      return result;
    }
    if (data.covered !== true || !Array.isArray(data.hits)) {
      console.warn(
        `${TAG} réponse inattendue en ${elapsed} ms (covered=${String(data.covered)}, hits=${Array.isArray(data.hits) ? 'array' : typeof data.hits}, version ${corpusVersion}) — "${short(trimmed)}"`,
      );
      return EMPTY;
    }
    const hits = (data.hits as Array<Partial<RagHit>>)
      .filter((hit) => hit && typeof hit.snippet === 'string')
      .slice(0, 3)
      .map((hit) => ({
        title: String(hit.title ?? '').slice(0, 200),
        path: String(hit.path ?? '').slice(0, 400),
        snippet: String(hit.snippet ?? '').trim(),
        dates: String(hit.dates ?? '').slice(0, 40),
      }))
      .filter((hit) => hit.snippet.length > 0);
    if (!hits.length) {
      console.warn(
        `${TAG} couvert sans extrait exploitable en ${elapsed} ms (version ${corpusVersion}) — "${short(trimmed)}"`,
      );
      const result: RagResult = { covered: false, corpusVersion, hits: [] };
      writeCache(key, result);
      return result;
    }
    console.info(
      `${TAG} couvert: ${hits.length} extrait(s) en ${elapsed} ms (version ${corpusVersion}) — "${short(trimmed)}"`,
    );
    const result: RagResult = { covered: true, corpusVersion, hits };
    writeCache(key, result);
    return result;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (timedOut) {
      console.warn(
        `${TAG} timeout après ${timeoutMs} ms (${elapsed} ms écoulés) — "${short(trimmed)}"`,
      );
    } else if (signal?.aborted) {
      console.debug(
        `${TAG} annulé avec le tour après ${elapsed} ms — "${short(trimmed)}"`,
      );
    } else {
      console.warn(
        `${TAG} erreur réseau après ${elapsed} ms: ${errorMessage(error)} — "${short(trimmed)}"`,
      );
    }
    // Fail-open : timeout, réseau, JSON invalide — jamais d'erreur au Dot.
    return EMPTY;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
