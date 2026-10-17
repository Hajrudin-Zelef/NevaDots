import type { Context } from 'hono';
import { ZodError } from 'zod';

/**
 * An error whose message is deliberately safe to return to the client.
 * Anything that is not a `PublicError`, a `ZodError`, or a message explicitly
 * recognized as ours is reported as a generic fallback — raw `error.message`
 * of an unexpected exception (stack-adjacent text, filesystem paths, upstream
 * responses) must never reach the client.
 */
export class PublicError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
  }
}

export interface ErrorMapping {
  /** Message returned for a Zod validation failure. */
  zodMessage: string;
  /** Recognizes our own safe, user-facing messages. */
  isSafe: (message: string) => boolean;
  /** HTTP status for a recognized-safe message (default 400). */
  statusFor?: (message: string) => number;
  /** Generic message for everything unclassified. */
  fallback: string;
  fallbackStatus: number;
  /** Short label used in the server log line. */
  logLabel: string;
}

/** Central Hono `onError` handler: classifies, logs, and never leaks internals. */
export function errorResponse(
  error: unknown,
  c: Context,
  mapping: ErrorMapping,
) {
  const json = (message: string, status: number) =>
    c.json({ error: message }, status as never);
  if (error instanceof ZodError) return json(mapping.zodMessage, 400);
  if (error instanceof PublicError) return json(error.message, error.status);
  const message = error instanceof Error ? error.message : '';
  if (message && mapping.isSafe(message))
    return json(message, mapping.statusFor?.(message) ?? 400);
  const name = error instanceof Error ? error.name : typeof error;
  console.error(
    `[${mapping.logLabel}] unhandled ${name}: ${message.slice(0, 300)}`,
  );
  return json(mapping.fallback, mapping.fallbackStatus);
}
