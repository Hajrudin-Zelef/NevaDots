import type { ProviderModels } from '../shared/models.js';
import {
  decryptSecret,
  encryptSecret,
  type SecretConfigStore,
} from './secrets.js';

/**
 * A model provider the agent can talk to. All are OpenAI-compatible
 * (`/chat/completions`), so the same adapter works for each; only the base
 * URL, API key and model list differ.
 */
export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  /** Selectable model ids for this provider. */
  models: string[];
  /** Where the owner can create an API key (shown in Settings). */
  keyUrl?: string;
}

/** Provider used when a Dot has no explicit provider. */
export const DEFAULT_PROVIDER_ID = 'opencode';

interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl: string;
  envKey: string;
  envBaseUrl: string;
  envModels: string;
  envModel?: string;
  /** Fallback model ids when neither the env nor the stored config lists any. */
  fallback: string[];
}

/** Built-in provider registry. Order is the order shown in Settings. */
export const PROVIDER_DEFS: readonly ProviderDef[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyUrl: 'https://opencode.ai/',
    envKey: 'OPENAI_API_KEY',
    envBaseUrl: 'OPENAI_BASE_URL',
    envModels: 'OPENAI_MODELS',
    envModel: 'OPENAI_MODEL',
    fallback: [],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    envKey: 'OPENROUTER_API_KEY',
    envBaseUrl: 'OPENROUTER_BASE_URL',
    envModels: 'OPENROUTER_MODELS',
    fallback: ['openrouter/auto'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    envKey: 'DEEPSEEK_API_KEY',
    envBaseUrl: 'DEEPSEEK_BASE_URL',
    envModels: 'DEEPSEEK_MODELS',
    fallback: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    baseUrl: 'https://nevallm.neva-ci.pro/v1',
    keyUrl: 'https://nevallm.neva-ci.pro/',
    envKey: 'FREELLMAPI_API_KEY',
    envBaseUrl: 'FREELLMAPI_BASE_URL',
    envModels: 'FREELLMAPI_MODELS',
    fallback: [],
  },
];

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Builds the initial provider list from the environment. */
export function buildProviders(env: NodeJS.ProcessEnv): ProviderConfig[] {
  return PROVIDER_DEFS.map((def) => {
    const models = splitList(env[def.envModels]);
    const single = def.envModel ? splitList(env[def.envModel]) : [];
    return {
      id: def.id,
      label: def.label,
      baseUrl: env[def.envBaseUrl] ?? def.baseUrl,
      apiKey: env[def.envKey]?.trim() || undefined,
      models: models.length
        ? models
        : single.length
          ? single
          : [...def.fallback],
      keyUrl: def.keyUrl,
    };
  });
}

export function findProvider(
  providers: ProviderConfig[] | undefined,
  id: string | null | undefined,
): ProviderConfig | undefined {
  if (!id) return undefined;
  return providers?.find((provider) => provider.id === id);
}

export function defaultProvider(
  providers: ProviderConfig[] | undefined,
): ProviderConfig | undefined {
  return findProvider(providers, DEFAULT_PROVIDER_ID) ?? providers?.[0];
}

/** Client-facing view of the registry (never exposes API keys). */
export function providersView(providers: ProviderConfig[]): ProviderModels[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: !!provider.apiKey,
    models: provider.models,
    keyUrl: provider.keyUrl,
  }));
}

/**
 * Mutable provider registry. It merges the environment defaults with the
 * owner's stored overrides (API keys and enabled models) and persists changes,
 * so the running agent picks them up without a restart.
 */
export class ProviderRegistry {
  private readonly providers: ProviderConfig[];
  private readonly envModel: string | undefined;
  /** Provider ids whose key was set through the UI (not inherited from env). */
  private readonly explicitKeys = new Set<string>();

  constructor(
    private readonly store: SecretConfigStore,
    private readonly secret: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.providers = buildProviders(env);
    this.envModel = splitList(env.OPENAI_MODEL)[0];
    for (const { key, value } of this.store.configList('provider:')) {
      const id = key.slice('provider:'.length);
      const provider = findProvider(this.providers, id);
      if (!provider) continue;
      try {
        const config = JSON.parse(value) as {
          keyCipher?: string;
          models?: string[];
        };
        if (config.keyCipher) {
          provider.apiKey = decryptSecret(config.keyCipher, this.secret);
          this.explicitKeys.add(id);
        }
        if (config.models) provider.models = config.models;
      } catch {
        /* ignore a corrupt stored entry */
      }
    }
  }

  list(): ProviderConfig[] {
    return this.providers;
  }

  view(): ProviderModels[] {
    return providersView(this.providers);
  }

  get(id: string): ProviderConfig | undefined {
    return findProvider(this.providers, id);
  }

  private persist(id: string) {
    const provider = this.get(id);
    if (!provider) return;
    const config: { keyCipher?: string; models?: string[] } = {};
    if (provider.apiKey && this.explicitKeys.has(id))
      config.keyCipher = encryptSecret(provider.apiKey, this.secret);
    if (provider.models.length) config.models = provider.models;
    if (!config.keyCipher && !config.models)
      this.store.configDelete(`provider:${id}`);
    else this.store.configSet(`provider:${id}`, JSON.stringify(config));
  }

  setKey(id: string, key: string) {
    const provider = this.get(id);
    if (!provider) throw new Error('Unknown provider.');
    provider.apiKey = key.trim();
    this.explicitKeys.add(id);
    this.persist(id);
  }

  deleteKey(id: string) {
    const provider = this.get(id);
    if (!provider) return;
    provider.apiKey = undefined;
    this.explicitKeys.delete(id);
    this.persist(id);
  }

  setModels(id: string, models: string[]) {
    const provider = this.get(id);
    if (!provider) throw new Error('Unknown provider.');
    provider.models = models;
    this.persist(id);
  }

  defaultRef(): { provider: string; model: string | null } | null {
    const raw = this.store.configGet('model_default');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { provider: string; model: string | null };
    } catch {
      return null;
    }
  }

  setDefault(provider: string, model: string | null) {
    this.store.configSet('model_default', JSON.stringify({ provider, model }));
  }

  /** Stored default, else the env default, else the default provider's first model. */
  effectiveDefault(): { provider: string; model: string | null } {
    const stored = this.defaultRef();
    const provider =
      findProvider(this.providers, stored?.provider) ??
      defaultProvider(this.providers);
    if (stored)
      return {
        provider: provider?.id ?? DEFAULT_PROVIDER_ID,
        model: stored.model ?? provider?.models[0] ?? null,
      };
    return {
      provider: provider?.id ?? DEFAULT_PROVIDER_ID,
      model: this.envModel ?? provider?.models[0] ?? null,
    };
  }
}
