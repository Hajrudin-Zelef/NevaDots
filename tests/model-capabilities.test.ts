import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearModelCapabilityCache,
  modelSupportsTools,
} from '../src/server/model-capabilities.js';

function input(fetchImpl: typeof fetch, model = 'test-model') {
  return {
    providerId: 'litellm',
    baseUrl: 'https://llm.example/v1/',
    model,
    apiKey: 'key',
    fetchImpl,
  };
}

describe('model capabilities (LiteLLM)', () => {
  beforeEach(() => clearModelCapabilityCache());

  it('ne sonde pas les autres providers', async () => {
    const fetchImpl = vi.fn();
    await expect(
      modelSupportsTools({
        ...input(fetchImpl as never),
        providerId: 'openai',
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('masque les outils quand supports_function_calling est false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            model_name: 'test-model',
            model_info: { supports_function_calling: false },
          },
        ],
      }),
    );
    await expect(modelSupportsTools(input(fetchImpl as never))).resolves.toBe(
      false,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://llm.example/model/info',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key' }),
      }),
    );
  });

  it('reste fail-open si le champ est absent, en erreur ou en 404', async () => {
    const missing = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: [{ model_name: 'test-model' }] }),
      );
    await expect(
      modelSupportsTools(input(missing as never)),
    ).resolves.toBeUndefined();

    clearModelCapabilityCache();
    const notFound = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(
      modelSupportsTools(input(notFound as never)),
    ).resolves.toBeUndefined();

    clearModelCapabilityCache();
    const network = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      modelSupportsTools(input(network as never)),
    ).resolves.toBeUndefined();
  });

  it('met en cache le résultat positif ou négatif', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            model_name: 'test-model',
            model_info: { supports_function_calling: false },
          },
        ],
      }),
    );
    await modelSupportsTools(input(fetchImpl as never));
    await modelSupportsTools(input(fetchImpl as never));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retrouve un alias via litellm_params.model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            model_name: 'another-alias',
            litellm_params: { model: 'openai/test-model' },
            model_info: { supports_function_calling: false },
          },
        ],
      }),
    );
    await expect(modelSupportsTools(input(fetchImpl as never))).resolves.toBe(
      false,
    );
  });
});
