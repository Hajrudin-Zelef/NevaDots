/**
 * Niveaux de raisonnement natifs par modèle (sélecteur de variantes).
 *
 * Source unique : le catalogue public OpenRouter (`GET /api/v1/models`,
 * champ `reasoning.supported_efforts` par modèle). Aucun niveau n'est
 * inventé : un niveau absent du natif est grisé dans l'UI, jamais envoyé.
 * Providers sans source fiable → statut `pending` (« en attente »).
 * Échec réseau ou modèle inconnu → `unknown` (fail-open : tout affiché,
 * comportement historique conservé).
 */

export type ReasoningLevelStatus = 'known' | 'unknown' | 'pending';

export interface ReasoningLevels {
  status: ReasoningLevelStatus;
  /** Niveaux natifs (sous-ensemble de low/medium/high/max). */
  levels?: string[];
  defaultEffort?: string | null;
  mandatory?: boolean;
}

interface CatalogReasoning {
  supported_efforts?: unknown;
  default_effort?: unknown;
  mandatory?: unknown;
}

interface CatalogEntry {
  id?: unknown;
  reasoning?: CatalogReasoning;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

let cache: { entries: CatalogEntry[]; expiresAt: number } | null = null;
let inFlight: Promise<CatalogEntry[]> | null = null;

async function fetchCatalog(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<CatalogEntry[]> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal });
  if (!response.ok) throw new Error(`catalog ${response.status}`);
  const payload = (await response.json()) as
    { data?: CatalogEntry[] } | CatalogEntry[];
  const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
  return Array.isArray(entries) ? entries : [];
}

function loadCatalog(fetchImpl: typeof fetch): Promise<CatalogEntry[]> {
  if (cache && cache.expiresAt > Date.now())
    return Promise.resolve(cache.entries);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const entries = await fetchCatalog(fetchImpl, controller.signal);
        cache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
        return entries;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return [];
    } finally {
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

function findEntry(
  entries: CatalogEntry[],
  model: string,
): CatalogEntry | undefined {
  const wanted = model.toLowerCase();
  return entries.find((entry) => {
    const id = typeof entry.id === 'string' ? entry.id.toLowerCase() : '';
    return (
      id === wanted ||
      id === `openrouter/${wanted}` ||
      id.endsWith(`/${wanted}`) ||
      wanted.endsWith(`/${id}`)
    );
  });
}

function asLevels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const levels = value.filter(
    (item): item is string =>
      typeof item === 'string' &&
      ['low', 'medium', 'high', 'max'].includes(item),
  );
  return levels;
}

/**
 * Niveaux natifs d'un modèle. Seul `openrouter` a une source live ;
 * tout autre provider → `pending` (en attente, rien d'inventé).
 */
export async function reasoningLevelsFor(
  provider: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ReasoningLevels> {
  if (provider !== 'openrouter' || !model.trim()) return { status: 'pending' };
  const entries = await loadCatalog(fetchImpl);
  if (!entries.length) return { status: 'unknown' };
  const entry = findEntry(entries, model.trim());
  const reasoning = entry?.reasoning;
  if (!reasoning) return { status: 'unknown' };
  const levels = asLevels(reasoning.supported_efforts);
  if (!levels) return { status: 'unknown' };
  return {
    status: 'known',
    levels,
    defaultEffort:
      typeof reasoning.default_effort === 'string'
        ? reasoning.default_effort
        : null,
    mandatory: reasoning.mandatory === true,
  };
}

/** Réservé aux tests : vide le cache du catalogue. */
export function resetReasoningLevelsForTests(): void {
  cache = null;
  inFlight = null;
}
