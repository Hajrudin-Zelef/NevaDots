/**
 * Optional Docker CPU cap for each computer, from `COMPUTER_CPUS`.
 *
 * A plain number of CPUs like "2" or "1.5" (NanoCpus = value × 1e9, rounded).
 * Unset or empty means no cap, exactly like `COMPUTER_MEMORY_BYTES`. Anything
 * else refuses to start the supervisor rather than run computers uncapped.
 */
export function computerCpus(
  raw: string | undefined,
): { ok: true; nanoCpus: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, nanoCpus: undefined };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      reason: `COMPUTER_CPUS must be a number of CPUs like "2" or "1.5" (got ${JSON.stringify(raw)}).`,
    };
  }
  const nanoCpus = Math.round(Number.parseFloat(trimmed) * 1_000_000_000);
  if (nanoCpus < 1) {
    return {
      ok: false,
      reason: `COMPUTER_CPUS must be a number of CPUs like "2" or "1.5" (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, nanoCpus };
}
