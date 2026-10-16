import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Minimum time (ms) a held mascot state stays on screen. Reasoning models can
 * flip from "reflection" to "writing" in a few hundred milliseconds, so without
 * a floor the thinking clip barely appears and the transition is invisible.
 */
export const MASCOT_HOLD_MS = 800;

/**
 * States worth holding: the avatar yields them only after `MASCOT_HOLD_MS`, so
 * every phase of a run stays perceivable even when the model is very fast.
 */
export const MASCOT_HELD_STATES: ReadonlySet<string> = new Set([
  'thinking',
  'analyzing',
  'searching',
  'writing',
]);

/**
 * States that take over instantly and drop any pending hold: voice (user
 * action) and pause. End-of-run flashes (`complete`/`error`) and `idle` are
 * deliberately NOT immediate — they queue behind the run's states so the user
 * still sees writing before the completion reaction.
 */
export const MASCOT_IMMEDIATE_STATES: ReadonlySet<string> = new Set([
  'listening',
  'paused',
]);

export interface MascotHoldState {
  /** State currently displayed. */
  shown: string;
  /** When `shown` became visible. */
  enteredAt: number;
  /** States waiting to be shown, in order (deduplicated). */
  queue: string[];
}

/** Fresh hold state for a given initial mascot state. */
export function initialMascotHold(
  shown: string,
  now = Date.now(),
): MascotHoldState {
  return { shown, enteredAt: now, queue: [] };
}

/**
 * Feeds a new raw state into the hold. Duplicates and the already-shown state
 * are ignored (and clear any stale queue); immediate states take over at once.
 * Pure so it can be unit-tested without React.
 */
export function enqueueMascotState(
  state: MascotHoldState,
  raw: string,
  now: number,
): MascotHoldState {
  if (raw === state.shown) {
    return state.queue.length ? { ...state, queue: [] } : state;
  }
  if (state.queue[state.queue.length - 1] === raw) return state;
  if (MASCOT_IMMEDIATE_STATES.has(raw)) {
    return { shown: raw, enteredAt: now, queue: [] };
  }
  return { ...state, queue: [...state.queue, raw] };
}

/**
 * Advances the queue as far as the minimum-visible-time allows. A held state
 * blocks until it has been visible `minMs`; a non-held state releases the next
 * one immediately. Pure (no timers).
 */
export function drainMascotHold(
  state: MascotHoldState,
  now: number,
  minMs: number = MASCOT_HOLD_MS,
): MascotHoldState {
  let current = state;
  for (let step = 0; step < 16 && current.queue.length > 0; step += 1) {
    const held = MASCOT_HELD_STATES.has(current.shown);
    if (held && now - current.enteredAt < minMs) break;
    const [next, ...rest] = current.queue;
    current = { shown: next, enteredAt: now, queue: rest };
  }
  return current;
}

/**
 * Holds mascot states so each is visible long enough. Returns the state to
 * display; the rail, token bar and hero all consume it. Honors
 * `prefers-reduced-motion` by disabling the floor.
 */
export function useHeldMascotState(
  raw: string,
  minMs: number = MASCOT_HOLD_MS,
): string {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hold = reduced ? 0 : minMs;
  const [state, setState] = useState<MascotHoldState>(() =>
    initialMascotHold(raw),
  );
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    const now = Date.now();
    const next = drainMascotHold(
      enqueueMascotState(ref.current, raw, now),
      now,
      hold,
    );
    if (next !== ref.current) {
      ref.current = next;
      setState(next);
    }
  }, [raw, hold]);

  // When the front of the queue is a held state still inside its floor, wake up
  // exactly when the floor elapses to release it.
  const readyAt = useMemo(() => {
    if (state.queue.length === 0) return null;
    return MASCOT_HELD_STATES.has(state.shown)
      ? state.enteredAt + hold
      : Date.now();
  }, [state, hold]);

  useEffect(() => {
    if (readyAt === null) return;
    const wait = Math.max(0, readyAt - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      const next = drainMascotHold(ref.current, now, hold);
      if (next !== ref.current) {
        ref.current = next;
        setState(next);
      }
    }, wait);
    return () => clearTimeout(timer);
  }, [readyAt, hold]);

  return state.shown;
}
