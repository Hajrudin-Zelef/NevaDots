import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Message } from '@ag-ui/core';
import {
  deriveRawRunStatus,
  getRunActivity,
  getRunMascotState,
  pushRunFrame,
  resetRunStatusModelForTests,
  type RunFrameInput,
} from '../src/client/run-status-model';

function msg(partial: Record<string, unknown>): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    content: '',
    ...partial,
  } as unknown as Message;
}

function toolCall(name: string, id = 'call-1') {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

function frame(overrides?: Partial<RunFrameInput>): RunFrameInput {
  return {
    messages: [],
    voiceActive: false,
    flash: '',
    paused: false,
    running: false,
    reasoningLive: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRunStatusModelForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetRunStatusModelForTests();
});

it('repos sans run : idle', () => {
  expect(deriveRawRunStatus(frame())).toBe('idle');
});

it('priorité voix > flash > pause', () => {
  expect(
    deriveRawRunStatus(
      frame({
        running: true,
        voiceActive: true,
        flash: 'complete',
        paused: true,
      }),
    ),
  ).toBe('listening');
  expect(deriveRawRunStatus(frame({ flash: 'error' }))).toBe('error');
  expect(deriveRawRunStatus(frame({ paused: true }))).toBe('paused');
});

it('recherche > écriture > raisonnement > attente', () => {
  expect(deriveRawRunStatus(frame({ running: true }))).toBe('thinking');
  expect(
    deriveRawRunStatus(frame({ running: true, reasoningLive: true })),
  ).toBe('analyzing');
  expect(
    deriveRawRunStatus(
      frame({
        running: true,
        reasoningLive: true,
        messages: [msg({ toolCalls: [toolCall('search_web')] })],
      }),
    ),
  ).toBe('searching');
  expect(
    deriveRawRunStatus(
      frame({
        running: true,
        messages: [msg({ toolCalls: [toolCall('computer_exec')] })],
      }),
    ),
  ).toBe('writing');
});

it('writing couvre le texte généré, borné au run courant', () => {
  const previous = msg({ content: 'ancienne réponse' });
  const user = msg({ role: 'user', content: 'suite ?' });
  // Run sans texte courant : pas de writing hérité de la réponse précédente.
  expect(
    deriveRawRunStatus(frame({ running: true, messages: [previous, user] })),
  ).toBe('thinking');
  // Texte en streaming après le dernier user : writing.
  expect(
    deriveRawRunStatus(
      frame({
        running: true,
        messages: [previous, user, msg({ content: 'voici…' })],
      }),
    ),
  ).toBe('writing');
});

it('hold 800 ms : thinking reste visible avant writing', () => {
  pushRunFrame(frame({ running: true }));
  expect(getRunMascotState()).toBe('thinking');
  pushRunFrame(
    frame({ running: true, messages: [msg({ content: 'texte…' })] }),
  );
  expect(getRunMascotState()).toBe('thinking');
  vi.advanceTimersByTime(800);
  expect(getRunMascotState()).toBe('writing');
});

it('pushRunFrame dérive aussi le flux d’activité en un seul point', () => {
  const messages = [
    msg({ toolCalls: [toolCall('computer_exec')] }),
    {
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'call-1',
      content: JSON.stringify({ stdout: 'ok\n', exitCode: 0 }),
    } as unknown as Message,
  ];
  pushRunFrame(frame({ running: true, messages }));
  const activity = getRunActivity();
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({ kind: 'command', status: 'ok' });
});
