import { useEffect, useRef, useState } from 'react';
import type { AbstractAgent } from '@ag-ui/client';
import type { Message, ToolCall } from '@ag-ui/core';
import {
  computerToolResult,
  describeToolOutcome,
  type ActivityKind,
  type ToolVerb,
} from '../shared/activity';

export type AgentStepStatus = 'running' | 'done' | 'error' | 'stopped';

/** Étape enrichie (lot 4) : identité de l'appel + résumé typé, jamais
 *  d'args bruts (voir `summarizeToolCall`). */
export interface AgentStep {
  id: string;
  label: string;
  status: AgentStepStatus;
  toolName?: string;
  toolCallId?: string;
  kind?: ActivityKind;
  verb?: ToolVerb;
  /** Résumé typé sûr à afficher (chemin, requête tronquée, compteur). */
  subtitle?: string;
  matchCount?: number;
  exitCode?: number;
  addedLines?: number;
  removedLines?: number;
  error?: string;
}

export interface StepHistoryEntry {
  messageId: string;
  steps: AgentStep[];
}

/** Identité d'appel portée par les événements STEP (`metadata.ndStep`,
 *  schémas AG-UI en `passthrough` — pas de nouveau protocole). */
function stepIdentity(event: unknown): {
  toolCallId?: string;
  toolName?: string;
} {
  const metadata = (
    event as { metadata?: { ndStep?: unknown } } | null | undefined
  )?.metadata?.ndStep;
  if (!metadata || typeof metadata !== 'object') return {};
  const { toolCallId, toolName } = metadata as Record<string, unknown>;
  return {
    toolCallId:
      typeof toolCallId === 'string' && toolCallId ? toolCallId : undefined,
    toolName:
      typeof toolName === 'string' && toolName ? toolName : undefined,
  };
}

function toolMessagesByCall(
  messages: Message[],
): Map<string, Message & { role: 'tool' }> {
  const map = new Map<string, Message & { role: 'tool' }>();
  for (const message of messages) {
    if (message.role === 'tool') {
      map.set(
        message.toolCallId,
        message as Message & { role: 'tool' },
      );
    }
  }
  return map;
}

function findToolCall(
  messages: Message[],
  toolCallId: string,
): ToolCall | undefined {
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const found = (message.toolCalls as ToolCall[]).find(
      (call) => call.id === toolCallId,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * Enrichit une étape depuis le transcript (`toolCalls[]` + message
 * `role:"tool"`). Sans message de résultat, l'étape reste `running` en
 * live ; `asStoppedIfUnresolved` la requalifie en `stopped` (appel
 * interrompu, pas une erreur) pour un transcript figé.
 */
export function enrichStepFromTranscript(
  step: AgentStep,
  messages: Message[],
  asStoppedIfUnresolved = false,
): AgentStep {
  if (!step.toolCallId) return step;
  const call = findToolCall(messages, step.toolCallId);
  if (!call) return step;
  const params = computerToolResult(call.function.arguments);
  const toolMessage = toolMessagesByCall(messages).get(step.toolCallId);
  // `describeToolOutcome` contient déjà le résumé typé (`ToolOutcome`
  // étend `ToolSummary`) : un second `summarizeToolCall` ici re-parsait
  // le contenu du résultat et recalculait le même résumé (revue finale,
  // Important 4).
  const outcome = describeToolOutcome(call.function.name, params, toolMessage);
  let status: AgentStepStatus;
  if (toolMessage) {
    status =
      outcome.status === 'ok'
        ? 'done'
        : outcome.status === 'error'
          ? 'error'
          : 'stopped';
  } else if (asStoppedIfUnresolved) {
    status = 'stopped';
  } else {
    status = step.status;
  }
  return {
    ...step,
    toolName: step.toolName ?? call.function.name,
    label: step.label || outcome.label,
    kind: outcome.kind,
    verb: outcome.verb,
    subtitle: outcome.subtitle || undefined,
    matchCount: outcome.matchCount,
    exitCode: outcome.exitCode,
    addedLines: outcome.addedLines,
    removedLines: outcome.removedLines,
    error: outcome.error || undefined,
    status,
  };
}

/**
 * Étapes d'un message assistant, dérivées du transcript (lot 4, étape 6) :
 * le repli quand il n'y a pas d'historique live (rechargement de page,
 * outils non-computer que `CopilotChatToolCallsView` rendait `null`).
 * Un appel sans message de résultat est `stopped` (interrompu), jamais
 * une erreur.
 */
export function stepsFromTranscriptMessage(
  message: Message,
  allMessages: Message[],
): AgentStep[] {
  if (message.role !== 'assistant' || !message.toolCalls?.length) return [];
  const toolMessages = toolMessagesByCall(allMessages);
  return (message.toolCalls as ToolCall[]).map((call) => {
    const params = computerToolResult(call.function.arguments);
    const toolMessage = toolMessages.get(call.id);
    // Même remarque que `enrichStepFromTranscript` : le résumé est déjà
    // dans `outcome`, pas de second `summarizeToolCall` (ni de second
    // `JSON.parse` du contenu du résultat).
    const outcome = describeToolOutcome(
      call.function.name,
      params,
      toolMessage,
    );
    const status: AgentStepStatus = toolMessage
      ? outcome.status === 'ok'
        ? 'done'
        : outcome.status === 'error'
          ? 'error'
          : 'stopped'
      : 'stopped';
    return {
      id: call.id,
      label: outcome.label,
      status,
      toolName: call.function.name,
      toolCallId: call.id,
      kind: outcome.kind,
      verb: outcome.verb,
      subtitle: outcome.subtitle || undefined,
      matchCount: outcome.matchCount,
      exitCode: outcome.exitCode,
      addedLines: outcome.addedLines,
      removedLines: outcome.removedLines,
      error: outcome.error || undefined,
    };
  });
}

/**
 * Collecte les étapes de l'agent pour la carte de progression (phase 3).
 * - `steps` : étapes du run en cours (temps réel).
 * - `history` : étapes des runs terminés, rattachées à leur message assistant.
 * Le backend émet STEP_STARTED / STEP_FINISHED depuis les appels d'outils,
 * avec l'identité de l'appel en `metadata.ndStep` ; l'appariement
 * fin/début se fait par `toolCallId` (repli sur le libellé pour les
 * événements sans identité, ex. drain d'étapes orphelines).
 *
 * Limitations connues (lot 4, fix round 1 — lecture acceptée, voir le
 * rapport du lot) :
 * - Enrichissement live différé : au `STEP_FINISHED`, le message
 *   `role:"tool"` n'est pas toujours déjà dans `agent.messages` ; l'étape
 *   bascule alors en `done` sans son résultat (matches, fichiers, exit
 *   code) — `finishRun` ré-enrichit depuis le transcript figé et corrige.
 * - Appels parallèles du même libellé : le serveur n'émet qu'un seul
 *   `STEP_STARTED` par libellé (contrainte protocole AG-UI, `StepTracker`
 *   : premier appel = représentant) ; ils partagent donc une seule étape
 *   et sont invisibles comme étapes distinctes. La fin d'un 2e appel
 *   solde l'étape du représentant par le repli libellé.
 */
export function useAgentSteps(agent: AbstractAgent | null) {
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [history, setHistory] = useState<StepHistoryEntry[]>([]);
  const stepsRef = useRef<AgentStep[]>([]);
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const setStepsSync = (
    next: AgentStep[] | ((cur: AgentStep[]) => AgentStep[]),
  ) => {
    const value = typeof next === 'function' ? next(stepsRef.current) : next;
    stepsRef.current = value;
    setSteps(value);
  };

  const resetSteps = () => setStepsSync([]);

  useEffect(() => {
    if (!agent) return;
    const finishRun = () => {
      const messages = agentRef.current?.messages ?? [];
      const done = stepsRef.current.map((s) => {
        const enriched = enrichStepFromTranscript(s, messages, true);
        return enriched.status === 'running'
          ? { ...enriched, status: 'done' as const }
          : enriched;
      });
      if (done.length) {
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        if (lastAssistant) {
          const entry: StepHistoryEntry = {
            messageId: lastAssistant.id,
            steps: done,
          };
          setHistory((prev) => [
            ...prev.filter((e) => e.messageId !== entry.messageId),
            entry,
          ]);
        }
      }
      setStepsSync([]);
    };
    const subscription = agent.subscribe({
      onRunStartedEvent: () => {
        setStepsSync([]);
      },
      onStepStartedEvent: ({ event }) => {
        const { toolCallId, toolName } = stepIdentity(event);
        const messages = agentRef.current?.messages ?? [];
        let step: AgentStep = {
          id: toolCallId ?? crypto.randomUUID(),
          label: event.stepName,
          status: 'running',
          toolName,
          toolCallId,
        };
        step = enrichStepFromTranscript(step, messages);
        setStepsSync((cur) => [...cur, step]);
      },
      onStepFinishedEvent: ({ event }) => {
        const { toolCallId } = stepIdentity(event);
        const messages = agentRef.current?.messages ?? [];
        setStepsSync((cur) => {
          const idx = toolCallId
            ? cur.findIndex(
                (s) => s.toolCallId === toolCallId && s.status === 'running',
              )
            : -1;
          const fallback =
            idx === -1
              ? cur.findIndex(
                  (s) => s.label === event.stepName && s.status === 'running',
                )
              : -1;
          const at = idx !== -1 ? idx : fallback;
          if (at === -1) return cur;
          const next = [...cur];
          const enriched = enrichStepFromTranscript(next[at], messages);
          next[at] = {
            ...enriched,
            status:
              enriched.status === 'running' ? 'done' : enriched.status,
          };
          return next;
        });
      },
      onRunFinishedEvent: () => {
        finishRun();
      },
      onRunErrorEvent: () => {
        finishRun();
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);

  return { steps, history, resetSteps };
}
