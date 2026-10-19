import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ComputerActivityEvent } from '../shared/computer-types';
import {
  appendActivityRun,
  parseActivityChunk,
  type TerminalRun,
} from './computer-activity';

export interface ComputerActivitySnapshot {
  runs: TerminalRun[];
  connected: boolean;
  error: string;
}

type Listener = {
  notify: () => void;
  onAgentStart?: (event: ComputerActivityEvent) => void;
};

type DotStream = {
  snapshot: ComputerActivitySnapshot;
  listeners: Set<Listener>;
  touchedAt: number;
  controller?: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  retry?: ReturnType<typeof setTimeout>;
};

const EMPTY_SNAPSHOT: ComputerActivitySnapshot = {
  runs: [],
  connected: false,
  error: '',
};

/** One retained, bounded stream per Dot, shared by the rail and computer pane. */
const streams = new Map<string, DotStream>();
const MAX_RETAINED_DOT_STREAMS = 16;

function streamFor(dotId: string): DotStream {
  let stream = streams.get(dotId);
  if (!stream) {
    stream = {
      snapshot: EMPTY_SNAPSHOT,
      listeners: new Set(),
      touchedAt: Date.now(),
    };
    streams.set(dotId, stream);
    pruneInactiveStreams(dotId);
  }
  return stream;
}

function pruneInactiveStreams(protectedDotId?: string): void {
  if (streams.size <= MAX_RETAINED_DOT_STREAMS) return;
  const inactive = [...streams.entries()]
    .filter(
      ([dotId, stream]) =>
        dotId !== protectedDotId &&
        !stream.listeners.size &&
        !stream.controller,
    )
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  while (streams.size > MAX_RETAINED_DOT_STREAMS && inactive.length) {
    const [dotId] = inactive.shift()!;
    streams.delete(dotId);
  }
}

function publish(
  stream: DotStream,
  patch: Partial<ComputerActivitySnapshot>,
): void {
  stream.touchedAt = Date.now();
  stream.snapshot = { ...stream.snapshot, ...patch };
  for (const listener of stream.listeners) listener.notify();
}

function stop(stream: DotStream): void {
  if (stream.retry) clearTimeout(stream.retry);
  stream.retry = undefined;
  const reader = stream.reader;
  stream.reader = undefined;
  const controller = stream.controller;
  stream.controller = undefined;
  controller?.abort();
  if (reader) void reader.cancel().catch(() => {});
  if (stream.snapshot.connected || stream.snapshot.error)
    publish(stream, { connected: false, error: '' });
}

function connect(dotId: string, stream: DotStream): void {
  if (!stream.listeners.size || stream.controller) return;
  const controller = new AbortController();
  stream.controller = controller;
  void (async () => {
    try {
      const response = await fetch(
        `/api/dots/${encodeURIComponent(dotId)}/computer/activity`,
        { credentials: 'include', signal: controller.signal },
      );
      if (!response.ok || !response.body)
        throw new Error(`Journal indisponible (${response.status}).`);
      if (controller.signal.aborted) return;
      const reader = response.body.getReader();
      stream.reader = reader;
      const decoder = new TextDecoder();
      let carry = '';
      publish(stream, { connected: true, error: '' });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseActivityChunk(
          carry,
          decoder.decode(value, { stream: true }),
        );
        carry = parsed.carry;
        if (!parsed.events.length) continue;
        const runs = parsed.events.reduce(
          (current, event) => appendActivityRun(current, event),
          stream.snapshot.runs,
        );
        publish(stream, { runs });
        for (const event of parsed.events) {
          if (event.phase !== 'start' || event.actor !== 'agent') continue;
          for (const listener of stream.listeners) {
            try {
              listener.onAgentStart?.(event);
            } catch {
              // UI notification must never break the shared terminal stream.
            }
          }
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && stream.controller === controller)
        publish(stream, {
          connected: false,
          error:
            cause instanceof Error ? cause.message : 'Journal indisponible.',
        });
    } finally {
      if (stream.controller === controller) {
        stream.reader = undefined;
        stream.controller = undefined;
        if (stream.snapshot.connected) publish(stream, { connected: false });
        if (stream.listeners.size)
          stream.retry = setTimeout(() => {
            stream.retry = undefined;
            connect(dotId, stream);
          }, 1500);
      }
    }
  })();
}

/** Subscribe a consumer; only the first consumer opens the Dot's SSE stream. */
export function subscribeComputerActivity(
  dotId: string,
  notify: () => void,
  onAgentStart?: (event: ComputerActivityEvent) => void,
): () => void {
  if (!dotId) return () => {};
  const stream = streamFor(dotId);
  const listener = { notify, onAgentStart };
  stream.listeners.add(listener);
  stream.touchedAt = Date.now();
  if (stream.listeners.size === 1) connect(dotId, stream);
  return () => {
    stream.listeners.delete(listener);
    if (!stream.listeners.size) {
      stop(stream);
      stream.touchedAt = Date.now();
      pruneInactiveStreams();
    }
  };
}

export function computerActivitySnapshot(
  dotId: string,
): ComputerActivitySnapshot {
  return streams.get(dotId)?.snapshot ?? EMPTY_SNAPSHOT;
}

/** Journal live du terminal d'un Dot, partagé sans doubler la connexion SSE. */
export function useComputerActivity(
  dotId: string,
  active: boolean,
  onAgentStart?: (event: ComputerActivityEvent) => void,
): ComputerActivitySnapshot {
  const onAgentStartRef = useRef(onAgentStart);
  onAgentStartRef.current = onAgentStart;
  const subscribe = useCallback(
    (notify: () => void) =>
      active
        ? subscribeComputerActivity(dotId, notify, (event) =>
            onAgentStartRef.current?.(event),
          )
        : () => {},
    [dotId, active],
  );
  const getSnapshot = useCallback(
    () => computerActivitySnapshot(dotId),
    [dotId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);
}
