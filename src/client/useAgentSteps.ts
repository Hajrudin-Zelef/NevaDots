import { useEffect, useRef, useState } from 'react';
import type { AbstractAgent } from '@ag-ui/client';

export interface AgentStep {
  id: string;
  label: string;
  status: 'running' | 'done';
}

export interface StepHistoryEntry {
  messageId: string;
  steps: AgentStep[];
}

/**
 * Collecte les étapes de l'agent pour la carte de progression (phase 3).
 * - `steps` : étapes du run en cours (temps réel).
 * - `history` : étapes des runs terminés, rattachées à leur message assistant.
 * Le backend émet STEP_STARTED / STEP_FINISHED depuis les appels d'outils.
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
      const done = stepsRef.current.map((s) => ({
        ...s,
        status: 'done' as const,
      }));
      if (done.length) {
        const messages = agentRef.current?.messages ?? [];
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
        const step: AgentStep = {
          id: crypto.randomUUID(),
          label: event.stepName,
          status: 'running',
        };
        setStepsSync((cur) => [...cur, step]);
      },
      onStepFinishedEvent: ({ event }) => {
        setStepsSync((cur) => {
          const idx = cur.findIndex(
            (s) => s.label === event.stepName && s.status === 'running',
          );
          if (idx === -1) return cur;
          const next = [...cur];
          next[idx] = { ...next[idx], status: 'done' };
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
