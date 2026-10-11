import { describe, expect, it, vi } from 'vitest';
import {
  compactMessages,
  estimateTokens,
  type ChatMessage,
} from '../src/server/context-compaction.js';
import { recallArchived } from '../src/server/tool-archive.js';

const big = 'detail '.repeat(300); // ~450 tokens per message

function sample(): ChatMessage[] {
  return [
    { id: 's', role: 'system', content: 'System rules.' },
    { id: 'u1', role: 'user', content: big },
    { id: 'a1', role: 'assistant', content: big },
    { id: 'u2', role: 'user', content: big },
    { id: 'a2', role: 'assistant', content: big },
    { id: 'u3', role: 'user', content: big },
    { id: 'a3', role: 'assistant', content: big },
    { id: 'u4', role: 'user', content: 'Final question?' },
  ];
}

function deps(fetchImpl: typeof fetch) {
  return {
    threadId: 'thread-c',
    model: 'test-model',
    apiKey: 'key',
    baseUrl: 'https://model.example/v1',
    contextWindow: 1000,
    fetchImpl,
    signal: new AbortController().signal,
  };
}

describe('context compaction', () => {
  it('leaves a small transcript untouched', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const outcome = await compactMessages(messages, deps(vi.fn()));
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toBe(messages);
  });

  it('summarizes the torso, keeps system + tail, and archives the rest', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content:
                'Decision: the earlier discussion covered six large detail exchanges.',
            },
          },
        ],
      }),
    );
    const messages = sample();
    const before = estimateTokens(messages);
    const outcome = await compactMessages(messages, deps(fetchImpl as never));
    expect(outcome.compacted).toBe(true);
    expect(estimateTokens(outcome.messages)).toBeLessThan(before);
    expect(outcome.messages[0].role).toBe('system');
    const marker = outcome.messages.find((m) =>
      String(m.content).includes('[CONTEXT COMPACTED]'),
    );
    expect(marker).toBeTruthy();
    expect(marker!.content).toContain('recall(id=');
    // Tail preserved.
    expect(outcome.messages.at(-1)?.content).toBe('Final question?');
    // Archived blocks are recallable verbatim.
    expect(outcome.archivedIds.length).toBeGreaterThan(0);
    expect(recallArchived(outcome.archivedIds[0])?.text.length).toBeGreaterThan(
      0,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the transcript when the summary call fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const messages = sample();
    const outcome = await compactMessages(messages, {
      ...deps(fetchImpl as never),
      threadId: 'thread-fail',
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toBe(messages);
  });
});
