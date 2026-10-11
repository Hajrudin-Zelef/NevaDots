import { describe, expect, it } from 'vitest';
import { classifyModelError } from '../src/server/model-errors.js';

describe('classifyModelError', () => {
  it('flags an unfunded provider with an actionable hint', () => {
    const message = classifyModelError(
      new Error('litellm error HTTP 402 insufficient balance'),
    );
    expect(message).toMatch(/crédit|solde/i);
    expect(message).toMatch(/OpenCode/i);
  });

  it('recognizes auth, model, rate limit and timeout failures', () => {
    expect(classifyModelError(new Error('401 invalid api key'))).toMatch(
      /clé d’API/i,
    );
    expect(classifyModelError(new Error('404 model not found'))).toMatch(
      /introuvable/i,
    );
    expect(classifyModelError(new Error('429 too many requests'))).toMatch(
      /débit/i,
    );
    expect(classifyModelError(new Error('fetch failed ETIMEDOUT'))).toMatch(
      /répondu à temps|joindre/i,
    );
  });

  it('falls back to a trimmed snippet for unknown errors', () => {
    expect(classifyModelError(new Error('weird   internal  failure'))).toMatch(
      /weird internal failure/,
    );
    expect(classifyModelError(undefined)).toMatch(/échoué/i);
  });
});
