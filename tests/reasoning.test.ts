import { expect, it, vi } from 'vitest';
import {
  buildReasoningStats,
  createReasoningFetch,
} from '../src/server/reasoning.js';
import {
  cacheHitFactorForModel,
  estimateCostUsd,
  priceForModel,
} from '../src/shared/pricing.js';

function sseResponse(lines: string[]): Response {
  const body = lines.join('\n');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

it('captures reasoning_content deltas and usage from an SSE stream', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":" step by step"}}]}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"usage":{"prompt_tokens":120,"completion_tokens":45}}',
    'data: [DONE]',
  ];
  const baseFetch = vi.fn(async () => sseResponse(chunks));
  const hooks = {
    onStart: vi.fn(),
    onDelta: vi.fn(),
    onUsage: vi.fn(),
    onEnd: vi.fn(),
  };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  const response = await wrapped(CHAT_URL, { method: 'POST' });
  // Drain the teed stream like the real adapter would.
  await response.text();

  expect(hooks.onStart).toHaveBeenCalledTimes(1);
  expect(hooks.onDelta.mock.calls.map((c) => c[0]).join('')).toBe(
    'Let me think step by step',
  );
  expect(hooks.onUsage).toHaveBeenCalledWith({
    promptTokens: 120,
    completionTokens: 45,
    cachedTokens: null,
    resolvedModel: null,
  });
  expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  const info = hooks.onEnd.mock.calls[0][0];
  expect(info.promptTokens).toBe(120);
  expect(info.completionTokens).toBe(45);
  expect(info.durationMs).toBeGreaterThanOrEqual(0);
});

it('captures OpenRouter-style reasoning deltas', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning":"Considering"}}]}',
    'data: [DONE]',
  ];
  const baseFetch = vi.fn(async () => sseResponse(chunks));
  const hooks = { onStart: vi.fn(), onDelta: vi.fn(), onEnd: vi.fn() };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  await (await wrapped(CHAT_URL)).text();
  expect(hooks.onStart).toHaveBeenCalledTimes(1);
  expect(hooks.onDelta.mock.calls[0][0]).toBe('Considering');
  expect(hooks.onEnd).toHaveBeenCalledTimes(1);
});

it('capture l’usage même quand le provider ne streame pas de reasoning', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"usage":{"prompt_tokens":250,"completion_tokens":30}}',
    'data: [DONE]',
  ];
  const baseFetch = vi.fn(async () => sseResponse(chunks));
  const hooks = {
    onStart: vi.fn(),
    onDelta: vi.fn(),
    onUsage: vi.fn(),
    onEnd: vi.fn(),
  };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  const text = await (await wrapped(CHAT_URL)).text();
  expect(text).toContain('Hi');
  expect(hooks.onStart).not.toHaveBeenCalled();
  expect(hooks.onDelta).not.toHaveBeenCalled();
  expect(hooks.onUsage).toHaveBeenCalledWith({
    promptTokens: 250,
    completionTokens: 30,
    cachedTokens: null,
    resolvedModel: null,
  });
  expect(hooks.onEnd).not.toHaveBeenCalled();
});

it('capture le modèle résolu du premier chunk (routeurs type openrouter/auto)', async () => {
  const chunks = [
    'data: {"model":"openai/gpt-6-luna","choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    'data: [DONE]',
  ];
  const baseFetch = vi.fn(async () => sseResponse(chunks));
  const hooks = {
    onStart: vi.fn(),
    onDelta: vi.fn(),
    onUsage: vi.fn(),
    onEnd: vi.fn(),
  };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  await (await wrapped(CHAT_URL)).text();
  expect(hooks.onUsage).toHaveBeenCalledWith({
    promptTokens: 10,
    completionTokens: 2,
    cachedTokens: null,
    resolvedModel: 'openai/gpt-6-luna',
  });
});

it('émet onUsage quand le modèle est capturé sans bloc usage (H-B)', async () => {
  const chunks = [
    'data: {"model":"openai/gpt-6-luna","choices":[{"delta":{"content":"Hi"}}]}',
    'data: [DONE]',
  ];
  const baseFetch = vi.fn(async () => sseResponse(chunks));
  const hooks = {
    onStart: vi.fn(),
    onDelta: vi.fn(),
    onUsage: vi.fn(),
    onEnd: vi.fn(),
  };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  await (await wrapped(CHAT_URL)).text();
  expect(hooks.onUsage).toHaveBeenCalledWith({
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    resolvedModel: 'openai/gpt-6-luna',
  });
  expect(hooks.onEnd).not.toHaveBeenCalled();
});

it('passes non-chat-completions requests through untouched', async () => {
  const sentinel = new Response('ok');
  const baseFetch = vi.fn(async () => sentinel);
  const hooks = { onStart: vi.fn(), onDelta: vi.fn(), onEnd: vi.fn() };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  const response = await wrapped('https://example.com/other');
  expect(response).toBe(sentinel);
  expect(hooks.onStart).not.toHaveBeenCalled();
});

it('builds stats with tok/s and cost estimate', () => {
  const stats = buildReasoningStats('deepseek/deepseek-chat-v3-0324', {
    promptTokens: 1000,
    completionTokens: 2000,
    durationMs: 4000,
  });
  expect(stats.tokensPerSecond).toBe(500);
  expect(stats.costUsd).toBeCloseTo((1000 * 0.27 + 2000 * 1.1) / 1e6, 8);
  expect(
    buildReasoningStats('unknown/model-x', {
      promptTokens: 10,
      completionTokens: 10,
      durationMs: 100,
    }).costUsd,
  ).toBeNull();
  expect(priceForModel('openrouter/deepseek/deepseek-chat-v3-0324')).toEqual([
    0.27, 1.1,
  ]);
  expect(estimateCostUsd('deepseek/deepseek-chat-v3-0324', null, 5)).toBeNull();
});

it('tarifie sur le modèle résolu quand un routeur a servi (openrouter/auto)', () => {
  // L'alias seul est inconnu → coût null (jamais 0).
  expect(
    buildReasoningStats('openrouter/auto', {
      promptTokens: 1000,
      completionTokens: 500,
      durationMs: 1000,
    }).costUsd,
  ).toBeNull();
  // Résolu gpt-6-luna : 1000×0.10 + 500×0.50 par million.
  const stats = buildReasoningStats('openrouter/auto', {
    promptTokens: 1000,
    completionTokens: 500,
    durationMs: 1000,
    resolvedModel: 'openai/gpt-6-luna',
  });
  expect(stats.resolvedModel).toBe('openai/gpt-6-luna');
  expect(stats.costUsd).toBeCloseTo((1000 * 0.1 + 500 * 0.5) / 1e6, 12);
});

it('finalizes stats on [DONE] even when the connection stays open', async () => {
  // Some proxies never close the SSE connection after [DONE] (and the SDK
  // stops reading there), so onEnd must fire on [DONE], not on EOF.
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      // Deliberately never close: the reader never sees done === true.
    },
  });
  const baseFetch = vi.fn(
    async () =>
      new Response(upstream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  const hooks = { onStart: vi.fn(), onDelta: vi.fn(), onEnd: vi.fn() };
  const wrapped = createReasoningFetch(
    baseFetch as unknown as typeof fetch,
    (url) => url.startsWith(CHAT_URL),
    hooks,
  );
  const response = await wrapped(CHAT_URL, { method: 'POST' });
  // Consume like the SDK: stop at [DONE] without waiting for EOF.
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (decoder.decode(value).includes('[DONE]')) break;
  }
  await reader.cancel();
  // Give the wrapper a tick to process the final lines.
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(hooks.onStart).toHaveBeenCalledTimes(1);
  expect(hooks.onDelta.mock.calls[0][0]).toBe('thinking');
  expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  expect(hooks.onEnd.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
});

const cacheFormats: Array<[string, string, number]> = [
  ['DeepSeek natif', '"prompt_cache_hit_tokens":800', 800],
  ['OpenAI/OpenRouter', '"prompt_tokens_details":{"cached_tokens":700}', 700],
  ['Anthropic via LiteLLM', '"cache_read_input_tokens":600', 600],
];
it.each(cacheFormats)(
  'extrait les tokens cache — %s',
  async (_label, field, expected) => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"x"}}]}',
      `data: {"usage":{"prompt_tokens":1000,"completion_tokens":10,${field}}}`,
      'data: [DONE]',
    ];
    const baseFetch = vi.fn(async () => sseResponse(chunks));
    const hooks = { onStart: vi.fn(), onDelta: vi.fn(), onEnd: vi.fn() };
    const wrapped = createReasoningFetch(
      baseFetch as unknown as typeof fetch,
      (url) => url.startsWith(CHAT_URL),
      hooks,
    );
    const response = await wrapped(CHAT_URL, { method: 'POST' });
    await response.text();
    expect(hooks.onEnd.mock.calls[0][0].cachedTokens).toBe(expected);
  },
);

it('facture les hits de cache au tarif du provider (F6)', () => {
  // DeepSeek : hit 0,07 $/1M contre 0,27 $ en miss (≈ 0,26×, pas 0,1×).
  expect(
    estimateCostUsd('deepseek/deepseek-chat-v3-0324', 1000, 0, 800),
  ).toBeCloseTo(((200 + 800 * (0.07 / 0.27)) * 0.27) / 1e6, 12);
  expect(cacheHitFactorForModel('deepseek/deepseek-chat-v3-0324')).toBeCloseTo(
    0.07 / 0.27,
    12,
  );
  // OpenAI/Anthropic : 0,1× inchangé.
  expect(cacheHitFactorForModel('openai/gpt-5')).toBe(0.1);
  expect(cacheHitFactorForModel('anthropic/claude-sonnet-4.5')).toBe(0.1);
  // 1000 prompt dont 800 relus : 200 plein + 800 × tarif cache.
  const stats = buildReasoningStats('deepseek/deepseek-chat-v3-0324', {
    promptTokens: 1000,
    completionTokens: 2000,
    cachedTokens: 500,
    durationMs: 1000,
  });
  expect(stats.cachedTokens).toBe(500);
  expect(stats.costUsd).toBeCloseTo(
    (500 * 0.27 + 500 * (0.07 / 0.27) * 0.27 + 2000 * 1.1) / 1e6,
    12,
  );
  // cachedTokens absent = comportement historique inchangé.
  expect(
    buildReasoningStats('deepseek/deepseek-chat-v3-0324', {
      promptTokens: 1000,
      completionTokens: 0,
      durationMs: 100,
    }).costUsd,
  ).toBeCloseTo((1000 * 0.27) / 1e6, 12);
});
