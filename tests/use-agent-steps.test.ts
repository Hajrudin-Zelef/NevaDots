import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import {
  enrichStepFromTranscript,
  stepsFromTranscriptMessage,
  useAgentSteps,
  type AgentStep,
} from '../src/client/useAgentSteps';

let root: ReactTestRenderer | undefined;
afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
});

const searchCall = {
  id: 'call-search',
  type: 'function',
  function: {
    name: 'search_web',
    arguments: JSON.stringify({ query: 'dette technique' }),
  },
};
const execCall = {
  id: 'call-exec',
  type: 'function',
  function: {
    name: 'computer_exec',
    arguments: JSON.stringify({ command: 'ls -la' }),
  },
};

function transcript(): Message[] {
  return [
    { id: 'u1', role: 'user', content: 'Cherche puis liste' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [searchCall, execCall],
    } as unknown as Message,
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-search',
      content: JSON.stringify({ results: [{}, {}] }),
    } as unknown as Message,
    {
      id: 't2',
      role: 'tool',
      toolCallId: 'call-exec',
      content: JSON.stringify({ exitCode: 1, stderr: 'boom' }),
    } as unknown as Message,
  ];
}

it('dérive les étapes du transcript : statut, résumé, matches, exit code', () => {
  const messages = transcript();
  const assistant = messages.find((m) => m.id === 'a1')!;
  const steps = stepsFromTranscriptMessage(assistant, messages);
  expect(steps).toHaveLength(2);
  expect(steps[0]).toMatchObject({
    toolName: 'search_web',
    status: 'done',
    verb: 'Exploré',
    matchCount: 2,
  });
  expect(steps[0].subtitle).toContain('dette technique');
  expect(steps[1]).toMatchObject({
    toolName: 'computer_exec',
    status: 'error',
    verb: 'Exécuté',
    exitCode: 1,
  });
  expect(steps[1].subtitle).toContain('ls -la');
});

it('stepsFromTranscriptMessage : le contenu du résultat n’est parsé qu’une fois', () => {
  const messages = transcript();
  const toolContent = (messages[2] as unknown as { content: string }).content;
  const parseSpy = vi.spyOn(JSON, 'parse');
  const steps = stepsFromTranscriptMessage(
    messages.find((m) => m.id === 'a1')!,
    messages,
  );
  // Avant la déduplication, `describeToolOutcome` ET `summarizeToolCall`
  // parsait chacun le contenu du résultat ; le résumé est désormais lu
  // dans `outcome`, qui l'inclut déjà (`ToolOutcome` étend `ToolSummary`).
  expect(
    parseSpy.mock.calls.filter(([arg]) => arg === toolContent),
  ).toHaveLength(1);
  parseSpy.mockRestore();
  // Comportement inchangé.
  expect(steps).toHaveLength(2);
  expect(steps[0]).toMatchObject({
    toolName: 'search_web',
    status: 'done',
    verb: 'Exploré',
    matchCount: 2,
  });
  expect(steps[0].subtitle).toContain('dette technique');
  expect(steps[1]).toMatchObject({
    toolName: 'computer_exec',
    status: 'error',
    verb: 'Exécuté',
    exitCode: 1,
  });
  expect(steps[1].subtitle).toContain('ls -la');
});

it('un appel sans message de résultat est interrompu, pas une erreur', () => {
  const messages = transcript().filter((m) => m.id !== 't2');
  const assistant = messages.find((m) => m.id === 'a1')!;
  const steps = stepsFromTranscriptMessage(assistant, messages);
  expect(steps[1].status).toBe('stopped');
  expect(steps[1].error).toBeUndefined();
});

it('compte les lignes ajoutées d’un write depuis le transcript', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-write',
          type: 'function',
          function: {
            name: 'computer_files_write',
            arguments: JSON.stringify({
              path: '/tmp/a.md',
              content: 'l1\nl2\nl3',
            }),
          },
        },
      ],
    } as unknown as Message,
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-write',
      content: JSON.stringify({ path: '/tmp/a.md' }),
    } as unknown as Message,
  ];
  const steps = stepsFromTranscriptMessage(messages[0], messages);
  expect(steps[0]).toMatchObject({
    status: 'done',
    verb: 'Modifié',
    addedLines: 3,
  });
  expect(steps[0].subtitle).toContain('/tmp/a.md');
});

it('enrichStepFromTranscript garde running en live sans résultat', () => {
  const messages = transcript().filter((m) => m.role !== 'tool');
  const running: AgentStep = {
    id: 'call-search',
    label: 'Recherche web',
    status: 'running',
    toolName: 'search_web',
    toolCallId: 'call-search',
  };
  const enriched = enrichStepFromTranscript(running, messages);
  expect(enriched.status).toBe('running');
  expect(enriched.subtitle).toContain('dette technique');
  const stopped = enrichStepFromTranscript(running, messages, true);
  expect(stopped.status).toBe('stopped');
});

// --- Hook : appariement fin/début par toolCallId ---------------------------

type Handlers = Record<string, (arg: unknown) => void>;

function FakeAgent({ messages }: { messages: Message[] }) {
  const handlers: Handlers = {};
  const agent = {
    messages,
    subscribe(next: Handlers) {
      Object.assign(handlers, next);
      return { unsubscribe: vi.fn() };
    },
  };
  return { agent, handlers };
}

function HookProbe({
  agent,
  onResult,
}: {
  agent: unknown;
  onResult: (value: ReturnType<typeof useAgentSteps>) => void;
}) {
  const result = useAgentSteps(agent as Parameters<typeof useAgentSteps>[0]);
  onResult(result);
  return null;
}

it('apparie STEP_FINISHED par toolCallId entre libellés distincts', async () => {
  // Deux appels en parallèle, libellés distincts, deux toolCallId.
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'go' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [searchCall, execCall],
    } as unknown as Message,
  ];
  const { agent, handlers } = FakeAgent({ messages });
  let seen: ReturnType<typeof useAgentSteps> | undefined;
  await act(async () => {
    root = create(
      createElement(HookProbe, {
        agent,
        onResult: (value) => {
          seen = value;
        },
      }),
    );
  });
  await act(async () => {
    handlers.onStepStartedEvent?.({
      event: {
        stepName: 'Recherche web',
        metadata: { ndStep: { toolCallId: 'c1', toolName: 'search_web' } },
      },
    });
    handlers.onStepStartedEvent?.({
      event: {
        stepName: 'Ordinateur : exec',
        metadata: { ndStep: { toolCallId: 'c2', toolName: 'computer_exec' } },
      },
    });
  });
  expect(seen?.steps).toHaveLength(2);
  expect(seen?.steps.map((s) => s.id)).toEqual(['c1', 'c2']);
  // La fin de c2 ne doit solder que c2 (par libellé, c1 aurait été soldée).
  await act(async () => {
    handlers.onStepFinishedEvent?.({
      event: {
        stepName: 'Ordinateur : exec',
        metadata: { ndStep: { toolCallId: 'c2', toolName: 'computer_exec' } },
      },
    });
  });
  expect(seen?.steps.find((s) => s.id === 'c1')?.status).toBe('running');
  expect(seen?.steps.find((s) => s.id === 'c2')?.status).toBe('done');
  // Sans identité, repli sur le libellé (événement drainé).
  await act(async () => {
    handlers.onStepFinishedEvent?.({ event: { stepName: 'Recherche web' } });
  });
  expect(seen?.steps.find((s) => s.id === 'c1')?.status).toBe('done');
});

it('un seul STEP_STARTED par libellé : le 2e appel parallèle partage l’étape du représentant', async () => {
  // Prémisse réelle (fix round 1) : le serveur (`StepTracker`) n'émet
  // qu'un seul STEP_STARTED par libellé — le premier appel est le
  // représentant, le 2e appel parallèle du même libellé n'a jamais sa
  // propre étape. Sa fin solde donc l'étape du représentant par le
  // repli libellé ; les deux appels restent invisibles comme étapes
  // distinctes (limitation documentée dans `useAgentSteps`).
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'go' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [searchCall],
    } as unknown as Message,
  ];
  const { agent, handlers } = FakeAgent({ messages });
  let seen: ReturnType<typeof useAgentSteps> | undefined;
  await act(async () => {
    root = create(
      createElement(HookProbe, {
        agent,
        onResult: (value) => {
          seen = value;
        },
      }),
    );
  });
  await act(async () => {
    handlers.onStepStartedEvent?.({
      event: {
        stepName: 'Recherche web',
        metadata: { ndStep: { toolCallId: 'c1', toolName: 'search_web' } },
      },
    });
  });
  expect(seen?.steps).toHaveLength(1);
  // Fin portée par le 2e appel (c2, sans étape propre) : le repli
  // libellé solde l'étape du représentant (c1).
  await act(async () => {
    handlers.onStepFinishedEvent?.({
      event: {
        stepName: 'Recherche web',
        metadata: { ndStep: { toolCallId: 'c2', toolName: 'search_web' } },
      },
    });
  });
  expect(seen?.steps).toHaveLength(1);
  expect(seen?.steps[0].id).toBe('c1');
  expect(seen?.steps[0].status).toBe('done');
});

it('enregistre l’historique enrichi à la fin du run', async () => {
  const messages = transcript();
  const { agent, handlers } = FakeAgent({ messages });
  let seen: ReturnType<typeof useAgentSteps> | undefined;
  await act(async () => {
    root = create(
      createElement(HookProbe, {
        agent,
        onResult: (value) => {
          seen = value;
        },
      }),
    );
  });
  await act(async () => {
    handlers.onStepStartedEvent?.({
      event: {
        stepName: 'Recherche web',
        metadata: {
          ndStep: { toolCallId: 'call-search', toolName: 'search_web' },
        },
      },
    });
    handlers.onStepStartedEvent?.({
      event: {
        stepName: 'Ordinateur : exec',
        metadata: {
          ndStep: { toolCallId: 'call-exec', toolName: 'computer_exec' },
        },
      },
    });
    handlers.onStepFinishedEvent?.({
      event: {
        stepName: 'Recherche web',
        metadata: {
          ndStep: { toolCallId: 'call-search', toolName: 'search_web' },
        },
      },
    });
    handlers.onRunFinishedEvent?.({});
  });
  expect(seen?.steps).toHaveLength(0);
  expect(seen?.history).toHaveLength(1);
  expect(seen?.history[0].messageId).toBe('a1');
  const [search, exec] = seen?.history[0].steps ?? [];
  expect(search.status).toBe('done');
  expect(search.matchCount).toBe(2);
  // L'exec sans FINISH explicite est soldé en erreur (résultat présent).
  expect(exec.status).toBe('error');
  expect(exec.exitCode).toBe(1);
});
