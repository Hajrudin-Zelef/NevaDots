/**
 * Parses JSON from a persisted or external source without ever throwing on a
 * corrupt value: a bad row must not crash boot or a request. The unreadable
 * value is logged and replaced by the caller's fallback.
 */
export function safeJsonParse<T>(
  raw: string | null | undefined,
  fallback: T,
  context: string,
): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(
      `[json] ${context}: unreadable JSON ignored (value length ${raw.length}).`,
    );
    return fallback;
  }
}
