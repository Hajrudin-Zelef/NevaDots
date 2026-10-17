import { useEffect, useState } from 'react';
import { authHeaders } from './api';
import {
  appendActivityRun,
  parseActivityChunk,
  type TerminalRun,
} from './computer-activity';

/** Journal live du terminal d'un Dot : commandes owner + agent au fil de l'eau.
 * Le flux est actif uniquement quand l'onglet Terminal est affiché. */
export function useComputerActivity(
  dotId: string,
  active: boolean,
): { runs: TerminalRun[]; connected: boolean; error: string } {
  const [runs, setRuns] = useState<TerminalRun[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setRuns([]);
    setError('');
    setConnected(false);
  }, [dotId]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = async () => {
      try {
        const response = await fetch(
          `/api/dots/${encodeURIComponent(dotId)}/computer/activity`,
          { headers: authHeaders(), signal: controller.signal },
        );
        if (!response.ok || !response.body)
          throw new Error(`Journal indisponible (${response.status}).`);
        setConnected(true);
        setError('');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let carry = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseActivityChunk(
            carry,
            decoder.decode(value, { stream: true }),
          );
          carry = parsed.carry;
          if (parsed.events.length)
            setRuns((current) => {
              let next = current;
              for (const event of parsed.events)
                next = appendActivityRun(next, event);
              return next;
            });
        }
      } catch (cause) {
        if (controller.signal.aborted || closed) return;
        setConnected(false);
        setError(
          cause instanceof Error ? cause.message : 'Journal indisponible.',
        );
      }
      if (!closed && !controller.signal.aborted)
        retry = setTimeout(() => void connect(), 1500);
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      controller.abort();
    };
  }, [dotId, active]);
  return { runs, connected, error };
}
