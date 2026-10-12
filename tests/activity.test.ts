import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { deriveActivity } from '../src/shared/activity';

it('derives a command event from a tool call and its result', () => {
  const messages = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'computer_exec',
            arguments: JSON.stringify({ command: 'ls -la' }),
          },
        },
      ],
    },
    {
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'call-1',
      content: JSON.stringify({ stdout: 'file.txt\n', exitCode: 0 }),
    },
  ] as unknown as Message[];
  const events = deriveActivity(messages);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    id: 'call-1',
    kind: 'command',
    label: 'Commande terminal',
    detail: 'ls -la',
    status: 'ok',
  });
  expect(events[0].result).toContain('file.txt');
});

it('marks a failed command with its exit code', () => {
  const messages = [
    {
      id: 'assistant-2',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'computer_exec',
            arguments: JSON.stringify({ command: 'false' }),
          },
        },
      ],
    },
    {
      id: 'tool-2',
      role: 'tool',
      toolCallId: 'call-2',
      content: JSON.stringify({ stdout: '', exitCode: 1 }),
    },
  ] as unknown as Message[];
  const events = deriveActivity(messages);
  expect(events[0].status).toBe('error');
});

it('shows a tool call without its result as still running', () => {
  const messages = [
    {
      id: 'assistant-3',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-3',
          type: 'function',
          function: {
            name: 'computer_navigate',
            arguments: JSON.stringify({ url: 'https://example.com' }),
          },
        },
      ],
    },
  ] as unknown as Message[];
  const events = deriveActivity(messages);
  expect(events[0]).toMatchObject({
    kind: 'web',
    label: 'Visite un site',
    detail: 'https://example.com',
    status: 'running',
  });
});
