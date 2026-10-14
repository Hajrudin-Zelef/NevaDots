import { describe, expect, it } from 'vitest';
import { modelKey, parseModelKey } from '../src/shared/models';
import {
  buildProviders,
  defaultProvider,
  findProvider,
  ProviderRegistry,
  providersView,
} from '../src/server/providers';
import {
  decryptSecret,
  encryptSecret,
  resolveSecretKey,
  type SecretConfigStore,
} from '../src/server/secrets';

describe('modelKey', () => {
  it('round-trips a provider and model', () => {
    const key = modelKey('openrouter', 'anthropic/claude-3.5-sonnet');
    expect(key).toBe('openrouter::anthropic/claude-3.5-sonnet');
    expect(parseModelKey(key)).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
    });
  });

  it('treats the empty value as the default (null)', () => {
    expect(parseModelKey('')).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(parseModelKey('nomodel')).toBeNull();
    expect(parseModelKey('::model')).toBeNull();
    expect(parseModelKey('provider::')).toBeNull();
  });
});

describe('provider registry (buildProviders)', () => {
  it('builds every provider with its own keys and endpoints', () => {
    const providers = buildProviders({
      OPENAI_API_KEY: 'oc',
      OPENAI_BASE_URL: 'http://127.0.0.1:4000/v1',
      OPENAI_MODELS: 'deepseek-v4-flash, glm-5.3-flash',
      OPENROUTER_API_KEY: 'or',
      DEEPSEEK_API_KEY: 'ds',
      FREELLMAPI_API_KEY: 'fl',
      FREELLMAPI_MODELS: 'glm-5.2,kimi-k3',
    });
    expect(providers.map((provider) => provider.id)).toEqual([
      'opencode',
      'openrouter',
      'deepseek',
      'freellmapi',
    ]);
    const opencode = findProvider(providers, 'opencode');
    expect(opencode?.baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(opencode?.apiKey).toBe('oc');
    expect(opencode?.models).toEqual(['deepseek-v4-flash', 'glm-5.3-flash']);
    expect(findProvider(providers, 'openrouter')?.apiKey).toBe('or');
    expect(findProvider(providers, 'deepseek')?.apiKey).toBe('ds');
    expect(findProvider(providers, 'freellmapi')?.models).toEqual([
      'glm-5.2',
      'kimi-k3',
    ]);
    expect(defaultProvider(providers)?.id).toBe('opencode');
  });

  it('falls back to sensible defaults when a provider is unconfigured', () => {
    const providers = buildProviders({});
    expect(findProvider(providers, 'opencode')?.apiKey).toBeUndefined();
    expect(findProvider(providers, 'deepseek')?.models).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(findProvider(providers, 'openrouter')?.models).toEqual([
      'openrouter/auto',
    ]);
    expect(findProvider(providers, 'freellmapi')?.baseUrl).toBe(
      'https://nevallm.neva-ci.pro/v1',
    );
    expect(defaultProvider(providers)?.id).toBe('opencode');
  });

  it('exposes configured status without leaking API keys', () => {
    const view = providersView(
      buildProviders({ OPENAI_API_KEY: 'secret', DEEPSEEK_API_KEY: 'secret2' }),
    );
    expect(
      view.find((provider) => provider.id === 'opencode')?.configured,
    ).toBe(true);
    expect(
      view.find((provider) => provider.id === 'openrouter')?.configured,
    ).toBe(false);
    expect(JSON.stringify(view)).not.toContain('secret');
  });
});

class MemoryConfigStore implements SecretConfigStore {
  private values = new Map<string, string>();
  configGet(key: string) {
    return this.values.get(key);
  }
  configSet(key: string, value: string) {
    this.values.set(key, value);
  }
  configDelete(key: string) {
    this.values.delete(key);
  }
  configList(prefix: string) {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }
}

describe('secrets', () => {
  it('round-trips an encrypted secret', () => {
    const cipher = encryptSecret('sk-live-123', 'server-secret');
    expect(cipher).not.toContain('sk-live-123');
    expect(decryptSecret(cipher, 'server-secret')).toBe('sk-live-123');
    expect(() => decryptSecret(cipher, 'other-secret')).toThrow();
  });

  it('generates and persists a key when none is configured', () => {
    const store = new MemoryConfigStore();
    const first = resolveSecretKey(store, {});
    expect(first).toHaveLength(44);
    expect(resolveSecretKey(store, {})).toBe(first);
    expect(resolveSecretKey(store, { SECRETS_KEY: 'env' })).toBe('env');
  });
});

describe('ProviderRegistry', () => {
  it('stores keys (encrypted) and enabled models, and reloads them', () => {
    const store = new MemoryConfigStore();
    const registry = new ProviderRegistry(store, 'secret', {});
    registry.setKey('openrouter', 'or-key');
    registry.setModels('openrouter', ['openrouter/auto', 'x/y']);
    expect(registry.get('openrouter')?.apiKey).toBe('or-key');
    expect(registry.get('openrouter')?.models).toEqual([
      'openrouter/auto',
      'x/y',
    ]);
    // Persisted key is encrypted, never plaintext.
    expect(store.configGet('provider:openrouter')).not.toContain('or-key');

    const reloaded = new ProviderRegistry(store, 'secret', {});
    expect(reloaded.get('openrouter')?.apiKey).toBe('or-key');
    expect(reloaded.get('openrouter')?.models).toEqual([
      'openrouter/auto',
      'x/y',
    ]);
  });

  it('does not persist env-provided keys', () => {
    const store = new MemoryConfigStore();
    const registry = new ProviderRegistry(store, 'secret', {
      OPENROUTER_API_KEY: 'env-key',
    });
    registry.setModels('openrouter', ['openrouter/auto']);
    expect(store.configGet('provider:openrouter')).not.toContain('env-key');
  });

  it('resolves a default and clears a deleted key', () => {
    const store = new MemoryConfigStore();
    const registry = new ProviderRegistry(store, 'secret', {
      OPENAI_MODEL: 'deepseek-v4.1-flash',
    });
    expect(registry.effectiveDefault()).toEqual({
      provider: 'opencode',
      model: 'deepseek-v4.1-flash',
    });
    registry.setDefault('deepseek', 'deepseek-reasoner');
    expect(registry.effectiveDefault()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    });
    registry.setKey('deepseek', 'k');
    registry.deleteKey('deepseek');
    expect(registry.get('deepseek')?.apiKey).toBeUndefined();
  });
});
