import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reasoningLevelsFor,
  resetReasoningLevelsForTests,
} from '../src/server/reasoning-levels';

afterEach(() => {
  resetReasoningLevelsForTests();
  vi.unstubAllGlobals();
});

function catalogFetch(entries: unknown[]) {
  return vi.fn(async () =>
    Response.json({ data: entries }),
  ) as unknown as typeof fetch;
}

describe('reasoningLevelsFor', () => {
  it('providers sans source fiable → pending (rien d’inventé)', async () => {
    const fetchImpl = catalogFetch([]);
    for (const provider of ['litellm', 'opencode', 'deepseek', 'x']) {
      expect(
        await reasoningLevelsFor(provider, 'n-importe-quel-modele', fetchImpl),
      ).toEqual({ status: 'pending' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('openrouter connu → niveaux natifs (+ défaut, mandatory)', async () => {
    const fetchImpl = catalogFetch([
      {
        id: 'anthropic/claude-opus-4-6',
        reasoning: {
          supported_efforts: ['low', 'medium', 'high', 'max'],
          default_effort: 'high',
          mandatory: false,
        },
      },
    ]);
    expect(
      await reasoningLevelsFor(
        'openrouter',
        'anthropic/claude-opus-4-6',
        fetchImpl,
      ),
    ).toEqual({
      status: 'known',
      levels: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'high',
      mandatory: false,
    });
  });

  it('efforts inconnus filtrés (xhigh/minimal ignorés)', async () => {
    const fetchImpl = catalogFetch([
      {
        id: 'openai/gpt-5.5',
        reasoning: {
          supported_efforts: ['none', 'minimal', 'low', 'xhigh'],
          default_effort: 'medium',
        },
      },
    ]);
    const result = await reasoningLevelsFor(
      'openrouter',
      'openai/gpt-5.5',
      fetchImpl,
    );
    expect(result.status).toBe('known');
    expect(result.levels).toEqual(['low']);
  });

  it('modèle absent ou catalogue en panne → unknown (fail-open)', async () => {
    const fetchImpl = catalogFetch([
      { id: 'x/y', reasoning: { supported_efforts: ['low'] } },
    ]);
    expect(
      await reasoningLevelsFor('openrouter', 'inconnu', fetchImpl),
    ).toEqual({ status: 'unknown' });
    resetReasoningLevelsForTests();
    const failing = vi.fn(async () => {
      throw new Error('réseau');
    }) as unknown as typeof fetch;
    expect(
      await reasoningLevelsFor('openrouter', 'x/y', failing),
    ).toEqual({ status: 'unknown' });
  });
  });
});
