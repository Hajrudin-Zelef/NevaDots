import { describe, expect, it, vi } from 'vitest';
import { magicCompactMessages } from '../src/server/magic-compaction';
import type { ChatMessage } from '../src/server/context-compaction';

function bigMessages(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'rules' }];
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: 'user',
      content:
        `Question utilisateur ${i} — exigence exacte à préserver. ` +
        'x'.repeat(800),
    });
    messages.push({
      role: 'assistant',
      content: `Réponse assistant ${i} avec décisions. ` + 'y'.repeat(800),
    });
    messages.push({
      role: 'tool',
      id: `call-${i}`,
      content: 'z'.repeat(5000),
    });
  }
  messages.push({ role: 'user', content: 'Question finale récente.' });
  messages.push({ role: 'assistant', content: 'Réponse finale récente.' });
  return messages;
}

function deps(fetchImpl: typeof fetch) {
  return {
    threadId: 'thread-magic',
    model: 'test-model',
    apiKey: 'key',
    baseUrl: 'https://model.example/v1',
    contextWindow: 8000,
    fetchImpl,
    signal: new AbortController().signal,
  };
}

describe('magic-compaction (phase 9)', () => {
  it('laisse un petit transcript intact', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const outcome = await magicCompactMessages(messages, deps(vi.fn()));
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toBe(messages);
  });

  it('garde les messages utilisateur intacts et résume par tour', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content:
                '[Tour 1] Résumé du premier tour.\n[Tour 3] Résumé du troisième tour.',
            },
          },
        ],
      }),
    );
    const messages = bigMessages();
    const userTexts = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    const outcome = await magicCompactMessages(messages, deps(fetchImpl));
    expect(outcome.compacted).toBe(true);
    // Messages utilisateur du torse : intacts, mot pour mot.
    for (const text of userTexts.slice(0, -1)) {
      expect(
        outcome.messages.some((m) => m.role === 'user' && m.content === text),
      ).toBe(true);
    }
    // Tours assistants résumés avec le marqueur.
    expect(
      outcome.messages.some(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('[MAGIC COMPACTED]'),
      ),
    ).toBe(true);
    // Gros I/O élagués avec notice d'omission.
    expect(
      outcome.messages.some(
        (m) =>
          m.role === 'tool' &&
          typeof m.content === 'string' &&
          m.content.includes('read_omitted_content'),
      ),
    ).toBe(true);
    expect(outcome.archivedIds.length).toBeGreaterThan(0);
  });
});
