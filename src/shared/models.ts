/**
 * Model selection shared by the server (`GET /models`) and the client
 * selectors. A Dot may pick a provider + model; when unset it follows the
 * server default provider.
 */
export interface ProviderModels {
  id: string;
  label: string;
  /** True when the provider has an API key configured on the server. */
  configured: boolean;
  models: string[];
  /** Where the owner can create an API key. */
  keyUrl?: string;
}

export interface ModelsResponse {
  default: { provider: string; model: string | null } | null;
  providers: ProviderModels[];
}

/** One model offered by a provider, as listed by its `/models` endpoint. */
export interface CatalogModel {
  id: string;
  name?: string;
}

export interface CatalogResponse {
  provider: string;
  models: CatalogModel[];
  /** 'live' when fetched from the provider, 'static' when from the fallback. */
  source: 'live' | 'static';
  error?: string;
}

/** Remaining balance of a provider's API key. */
export interface CreditEntry {
  provider: string;
  label: string;
  /** False when the provider exposes no balance endpoint. */
  supported: boolean;
  configured: boolean;
  /** Remaining credit when known (provider's own unit). */
  balance?: number;
  currency?: string;
  detail?: string;
  error?: string;
}

export interface CreditsResponse {
  credits: CreditEntry[];
}

/** Encodes a provider + model pair as a `<select>` value. */
export function modelKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/**
 * Decodes a `provider::model` select value. Returns null for the empty
 * (default) option or any malformed value.
 */
export function parseModelKey(
  value: string,
): { provider: string; model: string } | null {
  if (!value) return null;
  const index = value.indexOf('::');
  if (index <= 0) return null;
  const provider = value.slice(0, index);
  const model = value.slice(index + 2);
  return provider && model ? { provider, model } : null;
}
