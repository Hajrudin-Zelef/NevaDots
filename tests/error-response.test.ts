import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PublicError, errorResponse } from '../src/server/error-response';

function context() {
  return {
    json: (body: unknown, status: number) => ({ body, status }),
  } as never;
}

const mapping = {
  zodMessage: 'Invalid request.',
  isSafe: (m: string) => m.startsWith('Known message'),
  fallback: 'Something went wrong.',
  fallbackStatus: 503,
  logLabel: 'test',
};

describe('errorResponse', () => {
  it('maps a Zod error to the configured 400 message', () => {
    const res = errorResponse(
      new z.ZodError([]),
      context(),
      mapping,
    ) as unknown as { body: { error: string }; status: number };
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request.');
  });

  it('returns a PublicError message and status', () => {
    const res = errorResponse(
      new PublicError('Public detail.', 409),
      context(),
      mapping,
    ) as unknown as { body: { error: string }; status: number };
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Public detail.');
  });

  it('returns a recognized-safe message verbatim', () => {
    const res = errorResponse(
      new Error('Known message.'),
      context(),
      mapping,
    ) as unknown as { body: { error: string }; status: number };
    expect(res.body.error).toBe('Known message.');
  });

  it('never leaks an unclassified error message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = errorResponse(
      new Error('/home/sam/secret/path token=abc at Object.<anonymous>'),
      context(),
      mapping,
    ) as unknown as { body: { error: string }; status: number };
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Something went wrong.');
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
