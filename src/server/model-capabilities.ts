/**
 * Capabilities LiteLLM lues depuis `/model/info`.
 *
 * La sonde est facultative et fail-open : seuls les modèles explicitement
 * annoncés sans support d'appel d'outils sont restreints. Une erreur réseau,
 * un endpoint absent ou un champ inconnu laisse les outils disponibles.
 */
export interface ModelCapabilityInput {
  providerId?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface ModelInfoEntry {
  model_name?: string;
  litellm_params?: { model?: string };
  model_info?: { supports_function_calling?: boolean };
}

interface CacheEntry {
  value: boolean | undefined;
  expiresAt: number;
}

const LITELLM_PROVIDER = 'litellm';
const TIMEOUT_MS = 1_500;
const KNOWN_TTL_MS = 5 * 60_000;
const UNKNOWN_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean | undefined>>();

export function clearModelCapabilityCache(): void {
  cache.clear();
  inFlight.clear();
}

function modelInfoUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${root}/model/info`;
}

function findEntry(
  entries: ModelInfoEntry[],
  model: string,
): ModelInfoEntry | undefined {
  return (
    entries.find((entry) => entry.model_name === model) ??
    entries.find((entry) => entry.litellm_params?.model === model) ??
    entries.find((entry) => {
      const routed = entry.litellm_params?.model;
      return (
        !!routed &&
        (routed.endsWith(`/${model}`) || model.endsWith(`/${routed}`))
      );
    })
  );
}

async function probe(
  input: ModelCapabilityInput,
): Promise<boolean | undefined> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetchImpl(modelInfoUrl(input.baseUrl), {
      headers: {
        Accept: 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      signal,
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as
      { data?: ModelInfoEntry[] } | ModelInfoEntry[];
    const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
    const supported = findEntry(entries, input.model)?.model_info
      ?.supports_function_calling;
    return typeof supported === 'boolean' ? supported : undefined;
  } catch {
    return undefined;
  }
}

export async function modelSupportsTools(
  input: ModelCapabilityInput,
): Promise<boolean | undefined> {
  if (input.providerId !== LITELLM_PROVIDER) return true;

  const key = `${input.baseUrl}\n${input.model}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = probe(input)
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt:
          Date.now() +
          (typeof value === 'boolean' ? KNOWN_TTL_MS : UNKNOWN_TTL_MS),
      });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
