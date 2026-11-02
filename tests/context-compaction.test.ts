import { describe, expect, it, vi } from 'vitest';
import {
  compactMessages,
  compactionBudgets,
  estimateReserveTokens,
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
    contextWindow: 5000,
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
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 500 }));
    const messages = sample();
    const outcome = await compactMessages(messages, {
      ...deps(fetchImpl as never),
      threadId: 'thread-fail',
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toBe(messages);
  });

  it('calcule les budgets une seule fois à partir de la fenêtre brute', () => {
    expect(compactionBudgets(10_000, 4_000)).toEqual({
      usable: 6_000,
      trigger: 3_000,
      tail: 1_200,
    });
    // Équivalence : la réserve ne doit pas être soustraite deux fois.
    expect(compactionBudgets(6_000, 0)).toEqual(
      compactionBudgets(10_000, 4_000),
    );
    expect(compactionBudgets(5_000, 5_000)).toBeNull();
  });

  it('estime une réserve prudente pour le prompt et les schémas', () => {
    const prompt = 'x'.repeat(400);
    const tools = [{ description: 'y'.repeat(400) }, { description: '' }];
    // 400/4 + 200 = 300 ; (120 + 100) + (120 + 0) = 340.
    expect(estimateReserveTokens(prompt, tools)).toBe(640);
  });

  it('compacte plus tôt quand la réserve réduit la fenêtre utile', async () => {
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
    const withReserve = await compactMessages(messages, {
      ...deps(fetchImpl as never),
      contextWindow: 10_000,
      reserveTokens: 6_000,
      threadId: 'thread-reserve',
    });
    expect(withReserve.compacted).toBe(true);
    const withoutReserve = await compactMessages(messages, {
      ...deps(fetchImpl as never),
      contextWindow: 10_000,
      reserveTokens: 0,
      threadId: 'thread-no-reserve',
    });
    expect(withoutReserve.compacted).toBe(false);
  });

  it('ne compacte pas quand la réserve consomme toute la fenêtre', async () => {
    const fetchImpl = vi.fn();
    const messages = sample();
    const outcome = await compactMessages(messages, {
      ...deps(fetchImpl as never),
      contextWindow: 5_000,
      reserveTokens: 5_000,
      threadId: 'thread-no-room',
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe('reserve exceeds window');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
