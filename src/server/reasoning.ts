// Server-side capture of provider "reasoning" deltas from OpenAI-compatible
// SSE streams, plus per-run stats for the reasoning panel.
//
// The chat stack (TanStack AI -> CopilotKit BuiltInAgent -> AG-UI) does not
// guarantee reasoning passthrough, so we tee the raw SSE here and emit
// AG-UI REASONING_* events ourselves. If the provider emits no reasoning,
// nothing is emitted and the panel never opens.

import { estimateCostUsd } from '../shared/pricing.js';

export interface ReasoningRunStats {
  model: string;
  /** Wall-clock ms of the reasoning phase (first delta -> end). */
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  /** USD estimate, null when the model is not in the price table. */
  costUsd: number | null;
}

const statsByMessageId = new Map<string, ReasoningRunStats>();
const MAX_STORED = 200;

export function saveReasoningStats(
  messageId: string,
  stats: ReasoningRunStats,
): void {
  if (statsByMessageId.size >= MAX_STORED) {
    const oldest = statsByMessageId.keys().next().value;
    if (oldest !== undefined) statsByMessageId.delete(oldest);
  }
  statsByMessageId.set(messageId, stats);
}

export function getReasoningStats(
  messageId: string,
): ReasoningRunStats | undefined {
  return statsByMessageId.get(messageId);
}

export interface ReasoningStreamHooks {
  onStart(): void;
  onDelta(text: string): void;
  /** The answer/tool call started: close the reasoning message now. */
  onAnswerStart?(): void;
  onEnd(info: {
    promptTokens: number | null;
    completionTokens: number | null;
    durationMs: number;
  }): void;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface SseDelta {
  reasoning_content?: unknown;
  reasoning?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

interface SseChoice {
  delta?: SseDelta;
}

interface SseUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

interface SseChunk {
  choices?: SseChoice[];
  usage?: SseUsage;
}

/** DeepSeek-style `reasoning_content` and OpenRouter-style `reasoning`. */
function extractReasoningDelta(choice: SseChoice | undefined): string {
  const delta = choice?.delta;
  if (!delta || typeof delta !== 'object') return '';
  const raw = delta.reasoning_content ?? delta.reasoning;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part === 'object' && part !== null && 'text' in part
            ? String((part as { text: unknown }).text ?? '')
            : '',
      )
      .join('');
  }
  return '';
}

/**
 * Wrap fetch so chat-completions SSE streams are teed for reasoning deltas.
 * Non-matching requests pass through untouched. The returned body is a new
 * stream; the original response is never consumed by us.
 */
export function createReasoningFetch(
  baseFetch: typeof fetch,
  isChatCompletions: (url: string) => boolean,
  hooks: ReasoningStreamHooks,
): typeof fetch {
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let url: string | null;
    try {
      url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : typeof input === 'object' && input !== null && 'url' in input
              ? String((input as { url: unknown }).url ?? '')
              : null;
    } catch {
      url = null;
    }
    if (url === null || !isChatCompletions(url))
      return baseFetch(input, init);

    const startedAt = Date.now();
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      return response;
    }

    let reasoningActive = false;
    let ended = false;
    let answerStarted = false;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    const finish = () => {
      if (ended) return;
      ended = true;
      if (reasoningActive) {
        hooks.onEnd({
          promptTokens,
          completionTokens,
          durationMs: Date.now() - startedAt,
        });
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        // The provider signals end-of-stream here. Some proxies keep the
        // HTTP connection open afterwards (or the consumer stops reading),
        // so finalize now instead of waiting for EOF that may never come.
        finish();
        return;
      }
      let json: SseChunk | null;
      try {
        json = JSON.parse(data) as SseChunk;
      } catch {
        return;
      }
      const usage = json.usage;
      if (usage && typeof usage === 'object') {
        const p = toNumber(usage.prompt_tokens);
        const c = toNumber(usage.completion_tokens);
        if (p !== null) promptTokens = p;
        if (c !== null) completionTokens = c;
      }
      const choice = json.choices?.[0];
      if (!choice) return;
      const text = extractReasoningDelta(choice);
      if (text) {
        if (!reasoningActive) {
          reasoningActive = true;
          hooks.onStart();
        }
        hooks.onDelta(text);
        return;
      }
      // The answer (or a tool call) has started: close the reasoning message
      // now so the AG-UI stream stays well ordered (reasoning ends before
      // text). Stats keep collecting usage until [DONE].
      const delta = choice.delta;
      if (
        reasoningActive &&
        !answerStarted &&
        delta &&
        typeof delta === 'object' &&
        ((typeof delta.content === 'string' && delta.content.length > 0) ||
          delta.tool_calls !== undefined)
      ) {
        answerStarted = true;
        hooks.onAnswerStart?.();
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) handleLine(buffer);
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
  return fetchImpl;
}

export function buildReasoningStats(
  model: string,
  info: {
    promptTokens: number | null;
    completionTokens: number | null;
    durationMs: number;
  },
): ReasoningRunStats {
  const tokensPerSecond =
    info.completionTokens !== null && info.durationMs > 0
      ? info.completionTokens / (info.durationMs / 1000)
      : null;
  return {
    model,
    durationMs: info.durationMs,
    promptTokens: info.promptTokens,
    completionTokens: info.completionTokens,
    tokensPerSecond,
    costUsd: estimateCostUsd(
      model,
      info.promptTokens,
      info.completionTokens,
    ),
  };
}
