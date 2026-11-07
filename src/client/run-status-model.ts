import { useSyncExternalStore } from 'react';
import type { Message } from '@ag-ui/core';
import { deriveActivity, type ActivityEvent } from '../shared/activity.js';
import {
  drainMascotHold,
  enqueueMascotState,
  initialMascotHold,
  MASCOT_HELD_STATES,
  MASCOT_HOLD_MS,
  type MascotHoldState,
} from './useHeldMascotState.js';

/** Phase MVC-Statut (lot 2.1) : le statut du run est détenu par ce seul
 *  modèle. Chat y pousse un cadre (`pushRunFrame`), les vues s'abonnent
 *  (miroirs passifs). Priorité de dérivation identique à l'ancien
 *  `rawMascotState` de Chat — voir `specs/mascot-states.md`. */

export type RunMascotState =
  | 'idle'
  | 'thinking'
  | 'analyzing'
  | 'writing'
  | 'searching'
  | 'listening'
  | 'paused'
  | 'complete'
  | 'error';

export interface RunFrameInput {
  messages: Message[];
  voiceActive: boolean;
  flash: '' | 'complete' | 'error';
  paused: boolean;
  running: boolean;
  reasoningLive: boolean;
}

const WRITE_TOOL_CALLS =
  /files_write|computer_exec|computer_type|create_space_page|edit_space_page/;
const SEARCH_TOOL_CALLS = /search_web|read_public_page|web_search|web_fetch/;
const SEARCH_COMPUTER_CALLS =
  /computer_(navigate|snapshot|screenshot|read|click|scroll|key)/;

/** Dérivation pure du statut brut (priorité : voix > flash > pause >
 *  recherche > écriture/streaming > raisonnement > attente > repos). */
export function deriveRawRunStatus(input: RunFrameInput): RunMascotState {
  if (input.voiceActive) return 'listening';
  if (input.flash) return input.flash;
  if (input.paused) return 'paused';
  if (!input.running) return 'idle';
  const toolCalls = input.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const activeName = toolCalls.at(-1)?.function.name ?? '';
  if (
    SEARCH_TOOL_CALLS.test(activeName) ||
    SEARCH_COMPUTER_CALLS.test(activeName)
  )
    return 'searching';
  const writingTool =
    toolCalls.length > 0 &&
    WRITE_TOOL_CALLS.test(toolCalls[toolCalls.length - 1].function.name);
  // Texte généré après le dernier message utilisateur (sinon la réponse
  // précédente ferait passer en `writing` dès le début du run suivant).
  const lastUserIndex = input.messages.findLastIndex(
    (message) => message.role === 'user',
  );
  const runAssistant = input.messages
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === 'assistant')
    .at(-1);
  const streamingText =
    typeof runAssistant?.content === 'string' &&
    runAssistant.content.trim().length > 0;
  if (writingTool || streamingText) return 'writing';
  if (input.reasoningLive) return 'analyzing';
  return 'thinking';
}

let hold: MascotHoldState = initialMascotHold('idle');
let activity: ActivityEvent[] = [];
const listeners = new Set<() => void>();
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  for (const fn of listeners) fn();
}

/** Évite les notifications (et re-rendus) quand rien n'a bougé : le flux
 *  est re-dérivé à chaque cadre — le raisonnement en streaming grandit à
 *  `id` constant, d'où la comparaison de tous les champs scalaires. */
function sameActivity(a: ActivityEvent[], b: ActivityEvent[]): boolean {
  return (
    a.length === b.length &&
    a.every((event, index) => {
      const other = b[index];
      return (
        event.id === other.id &&
        event.kind === other.kind &&
        event.label === other.label &&
        event.detail === other.detail &&
        event.status === other.status &&
        (event.result ?? '') === (other.result ?? '') &&
        (event.error ?? '') === (other.error ?? '')
      );
    })
  );
}

function holdMs(): number {
  const reduced =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return reduced ? 0 : MASCOT_HOLD_MS;
}

/** Pousse un cadre : dérive le statut brut + l'activité, avance le hold,
 *  arme le réveil, notifie. Seul point de dérivation (Chat + tests). */
export function pushRunFrame(input: RunFrameInput): void {
  const raw = deriveRawRunStatus(input);
  const now = Date.now();
  const minMs = holdMs();
  if (wakeTimer !== undefined) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  const prevHold = hold;
  hold = drainMascotHold(enqueueMascotState(hold, raw, now), now, minMs);
  const nextActivity = deriveActivity(input.messages);
  if (hold !== prevHold || !sameActivity(activity, nextActivity)) {
    activity = nextActivity;
    notify();
  }
  const readyAt =
    hold.queue.length === 0
      ? null
      : MASCOT_HELD_STATES.has(hold.shown)
        ? hold.enteredAt + minMs
        : now;
  if (readyAt !== null) {
    const wait = Math.max(0, readyAt - now);
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      const at = Date.now();
      const next = drainMascotHold(hold, at, holdMs());
      if (next !== hold) {
        hold = next;
        notify();
      }
    }, wait);
  }
}

/** Statut affiché (après hold). */
export function getRunMascotState(): RunMascotState {
  return hold.shown as RunMascotState;
}

export function subscribeRunStatus(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Miroir React du statut (re-rendu à chaque notification du modèle). */
export function useRunMascotState(): RunMascotState {
  return useSyncExternalStore(
    subscribeRunStatus,
    getRunMascotState,
    getRunMascotState,
  );
}

/** Dernier flux d'activité dérivé (rail, persistance). */
export function getRunActivity(): ActivityEvent[] {
  return activity;
}

export function subscribeRunActivity(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Miroir React du flux d'activité. */
export function useRunActivity(): ActivityEvent[] {
  return useSyncExternalStore(
    subscribeRunActivity,
    getRunActivity,
    getRunActivity,
  );
}

/** Réservé aux tests : réinitialise le modèle entre deux cas. */
export function resetRunStatusModelForTests(): void {
  if (wakeTimer !== undefined) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  hold = initialMascotHold('idle');
  activity = [];
  listeners.clear();
}
