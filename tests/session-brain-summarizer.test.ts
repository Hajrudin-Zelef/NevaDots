import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionBrainStore,
  type SessionBrainScope,
} from '../src/server/session-brain.js';
import {
  SessionBrainSummarizer,
  type SessionSummaryRequest,
} from '../src/server/session-brain-summarizer.js';

const roots: string[] = [];
const scope: SessionBrainScope = {
  userId: 'user-1',
  dotId: 'dot-1',
  threadId: 'thread-1',
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-summary-'));
  roots.push(root);
  return new SessionBrainStore({ rootDir: root });
}

function request(
  store: SessionBrainStore,
  overrides: Partial<SessionSummaryRequest> = {},
): SessionSummaryRequest {
  return {
    store,
    scope,
    beforeNotes: '',
    userText: 'u'.repeat(200),
    assistantText: 'a'.repeat(200),
    model: 'test-model',
    baseUrl: 'https://model.example/v1',
    apiKey: 'key',
    ...overrides,
  };
}

function reply(notes = '- Décision durable importante à conserver.\n') {
  return Response.json({
    choices: [{ message: { content: notes } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  });
}

afterEach(() => {
  vi.useRealTimers();
  roots
    .splice(0)
    .reverse()
    .forEach((dir) => rmSync(dir, { recursive: true }));
});

describe('SessionBrainSummarizer', () => {
  it('fusionne le tour dans les notes et remonte l’usage', async () => {
    const store = fixture();
    const onUsage = vi.fn();
    const summarizer = new SessionBrainSummarizer();
    const fetchImpl = vi.fn().mockResolvedValue(reply());
    await expect(
      summarizer.summarizeNow(
        request(store, { fetchImpl: fetchImpl as never, onUsage }),
      ),
    ).resolves.toBe(true);
    expect(await store.read(scope)).toContain('Décision durable');
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 10,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://model.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('ajoute les nouvelles puces sans écraser les anciennes', async () => {
    const store = fixture();
    const existing = '# Notes\n\n- Ancienne note importante\n';
    await store.write(scope, existing);
    const summarizer = new SessionBrainSummarizer();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(reply('- Nouvelle note durable\n'));
    await expect(
      summarizer.summarizeNow(
        request(store, {
          beforeNotes: existing,
          fetchImpl: fetchImpl as never,
        }),
      ),
    ).resolves.toBe(true);
    const notes = await store.read(scope);
    expect(notes).toContain('Ancienne note importante');
    expect(notes).toContain('Nouvelle note durable');
  });

  it('annule si les notes ont changé entre-temps', async () => {
    const store = fixture();
    await store.write(scope, '# Notes\n\n- Note utilisateur\n');
    const fetchImpl = vi.fn().mockResolvedValue(reply());
    const summarizer = new SessionBrainSummarizer();
    await expect(
      summarizer.summarizeNow(
        request(store, {
          beforeNotes: '',
          fetchImpl: fetchImpl as never,
        }),
      ),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignore un tour trop court', async () => {
    const store = fixture();
    const fetchImpl = vi.fn();
    const summarizer = new SessionBrainSummarizer();
    await expect(
      summarizer.summarizeNow(
        request(store, {
          userText: 'hi',
          assistantText: 'hello',
          fetchImpl: fetchImpl as never,
        }),
      ),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('échoue silencieusement si le provider répond mal', async () => {
    const store = fixture();
    const summarizer = new SessionBrainSummarizer();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(
      summarizer.summarizeNow(
        request(store, { fetchImpl: fetchImpl as never }),
      ),
    ).resolves.toBe(false);
    expect(await store.read(scope)).toBe('');
  });

  it('attend le debounce avant de lancer le résumé', async () => {
    vi.useFakeTimers();
    const store = fixture();
    const fetchImpl = vi.fn().mockResolvedValue(reply());
    const summarizer = new SessionBrainSummarizer({ debounceMs: 5_000 });
    summarizer.schedule(request(store, { fetchImpl: fetchImpl as never }));
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    await summarizer.waitForIdle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await store.read(scope)).toContain('Décision durable');
  });
});
