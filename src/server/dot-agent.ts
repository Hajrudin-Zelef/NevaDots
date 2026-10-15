import { parallelSources } from './parallel.js';
import { pageReviewTool } from '../shared/page-review.js';
import { ComputerService } from './computer-service.js';
import { computerTools } from './computer-tools.js';
import { externalAccountTools } from './external-tools.js';
import { ConnectionService } from './connections.js';
import { connectionTools } from './connection-tools.js';
import { connectionActionTool } from '../shared/connection-types.js';
import { pageAccess, pageTools } from './page-tools.js';
import { cachePage, grepPage, slicePage, summarizePage } from './page-cache.js';
import {
  archiveResult,
  hasArchives,
  recallArchived,
  searchArchived,
} from './tool-archive.js';
import { compactMessages, type ChatMessage } from './context-compaction.js';
import { magicCompactMessages } from './magic-compaction.js';
import { classifyModelError } from './model-errors.js';
import { AbstractAgent } from '@ag-ui/client';
import {
  type BaseEvent,
  type RunAgentInput,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
  EventType,
} from '@ag-ui/core';
import {
  BuiltInAgent,
  type ToolDefinition,
  defineTool,
  convertInputToTanStackAI,
} from '@copilotkit/runtime/v2';
import { chat, maxIterations } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { tanstackTools } from './tanstack-tools.js';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
import { defaultProvider, findProvider } from './providers.js';
import { browserResponse } from './research.js';
import { answerObserver, type SetupTelemetry } from './setup-telemetry.js';
import {
  buildReasoningStats,
  createReasoningFetch,
  saveReasoningStats,
} from './reasoning.js';
import { stepLabelForTool } from './agent-steps.js';
import { buildSystemPrompt } from './agent-prompt.js';
import { injectAttachedImages } from './attached-images.js';
import { screenshotMiddleware } from './screenshot-middleware.js';
import { brainTools } from './brain-tools.js';
import { consultBrainSync } from './operator-brain.js';
const channelError = () => ({
  type: EventType.RUN_ERROR,
  message:
    'NevaDots could not complete this request. Please check the app and try again.',
});
const TURN_TIME_LIMIT_MS = 90_000;
/**
 * Cap the size of a tool result fed back to the model. Large page/terminal
 * outputs are kept in full for the UI (capture/brief) but resent to the model
 * on every agent iteration; truncating here keeps each prompt small so turns
 * stay fast (the model only needs a representative excerpt).
 */
const TOOL_RESULT_LIMIT = 6000;
export class DotAgent extends AbstractAgent {
  private inner?: BuiltInAgent;
  private controller?: AbortController;
  constructor(
    private store: Store,
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    private dotId: string,
    private channel = false,
    private setupTelemetry?: SetupTelemetry,
  ) {
    super({ agentId: dotId });
  }
  clone() {
    return new DotAgent(
      this.store,
      this.workspace,
      this.config,
      this.dotId,
      this.channel,
      this.setupTelemetry,
    );
  }
  abortRun() {
    this.controller?.abort();
    this.inner?.abortRun();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.controller = controller;
      let subscription: { unsubscribe(): void } | undefined;
      let watcher: ReturnType<typeof setInterval> | undefined;
      let timedOut = false;
      let finished = false;
      let configurationFailure = false;
      // Phase 3 : associe chaque appel d'outil à son libellé d'étape
      // (TOOL_CALL_END ne porte pas le nom de l'outil).
      const stepLabels = new Map<string, string>();
      const observe = answerObserver((event) =>
        this.setupTelemetry?.capture(event),
      );
      const timeout = setTimeout(() => {
        timedOut = true;
        observe({ type: EventType.RUN_ERROR });
        this.abortRun();
      }, TURN_TIME_LIMIT_MS);
      const timeLimitError = () => ({
        type: EventType.RUN_ERROR,
        message: `This turn reached the ${TURN_TIME_LIMIT_MS / 1000} second time limit and was stopped. Try a smaller request.`,
      });
      // Reasoning capture teardown hooks (assigned inside try when used).
      let closeReasoning: () => void = () => {};
      let restoreFetch: () => void = () => {};
      try {
        const dot = this.workspace.dot(this.dotId);
        if (!dot) throw new Error('Specialist Dot not found.');
        if (
          this.channel &&
          !this.workspace
            .conversations()
            .some((thread) => thread.id === input.threadId)
        )
          this.workspace.bindThread(
            input.threadId,
            dot.id,
            'Slack conversation',
          );
        this.workspace.requireThread(input.threadId, dot.id);
        // Resolve the Dot's provider (falling back to the server default) and
        // use its endpoint + key. `dot.model` may override the provider default.
        const fallbackDefault =
          this.config.providerRegistry?.effectiveDefault();
        const explicitProvider = findProvider(
          this.config.providers,
          dot.provider,
        );
        const provider =
          explicitProvider ??
          findProvider(this.config.providers, fallbackDefault?.provider) ??
          defaultProvider(this.config.providers);
        const apiKey = provider?.apiKey ?? this.config.apiKey;
        const baseUrl =
          provider?.baseUrl ??
          this.config.baseUrl ??
          'https://api.openai.com/v1';
        const model =
          dot.model ??
          (explicitProvider
            ? explicitProvider.models[0]
            : fallbackDefault?.model) ??
          this.config.model ??
          provider?.models[0];
        if (!apiKey || !model) {
          configurationFailure = true;
          this.setupTelemetry?.capture({
            kind: 'setup_failed',
            step: 'setup_required',
            error_class: 'configuration_missing',
          });
          throw new Error('Model configuration is required.');
        }
        const initialSettings = this.store.settings();
        const initialConnections = this.workspace.connections.fingerprint(
          dot.id,
        );
        const check = () => {
          const settings = this.store.settings();
          const current = this.workspace.dot(dot.id);
          if (
            settings.paused ||
            !current ||
            settings.researchAllowed !== initialSettings.researchAllowed ||
            settings.memoryAllowed !== initialSettings.memoryAllowed ||
            current.memoryAllowed !== dot.memoryAllowed ||
            current.learningContainerId !== dot.learningContainerId ||
            current.skillDeliveryEnabled !== dot.skillDeliveryEnabled ||
            current.researchAllowed !== dot.researchAllowed ||
            current.spaceId !== dot.spaceId ||
            this.workspace.connections.fingerprint(dot.id) !==
              initialConnections ||
            JSON.stringify(current.spaceIds) !== JSON.stringify(dot.spaceIds)
          )
            this.abortRun();
          controller.signal.throwIfAborted();
        };
        check();
        watcher = setInterval(() => {
          try {
            check();
          } catch {
            this.abortRun();
          }
        }, 100);
        const computer = new ComputerService(
          this.workspace,
          this.config,
          () => this.store.settings().paused,
        );
        const tools: ToolDefinition[] =
          dot.researchAllowed &&
          initialSettings.researchAllowed &&
          this.config.webSearchProvider === 'browser' &&
          !computer.configured
            ? [
                defineTool({
                  name: 'read_public_page',
                  description:
                    'Read a provided canonical public HTTP(S) URL in a separate read-only browser. Returns a compact outline and a short head excerpt with a pageId; use read_page_slice or grep_page to read more. No web search, redirects, authenticated sites, or write actions.',
                  parameters: z.object({ url: z.string().url().max(2048) }),
                  execute: async ({ url }) => {
                    check();
                    if (!this.store.settings().researchAllowed)
                      throw new Error('Research permission is disabled.');
                    if (!this.config.browserUrl || !this.config.browserSecret)
                      throw new Error(
                        'Browser is not configured: set BROWSER_URL and BROWSER_SECRET.',
                      );
                    const response = await fetch(
                      `${this.config.browserUrl.replace(/\/$/, '')}/browse`,
                      {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${this.config.browserSecret}`,
                        },
                        body: JSON.stringify({ url }),
                        signal: controller.signal,
                      },
                    );
                    if (!response.ok)
                      throw new Error(
                        `Browser returned HTTP ${response.status}. Provide a public canonical page URL; redirects and private addresses are blocked.`,
                      );
                    const page = browserResponse.parse(await response.json());
                    check();
                    this.workspace.saveCapture(input.threadId, {
                      sample: false,
                      text: page.text,
                      sources: [
                        {
                          title: page.title,
                          url: page.url,
                          excerpt: page.text.slice(0, 320),
                        },
                      ],
                      screenshot: page.screenshot,
                    });
                    return summarizePage(
                      cachePage(page.title, page.url, page.text),
                    );
                  },
                }),
              ]
            : [];
        if (
          dot.researchAllowed &&
          initialSettings.researchAllowed &&
          (this.config.webSearchProvider ?? 'parallel') === 'parallel'
        ) {
          const capture = async (
            objective: string,
            urls?: string[],
            searchQueries?: string[],
          ) => {
            const limitations: string[] = [];
            check();
            const sources = await parallelSources(
              {
                objective,
                urls,
                sessionId: input.threadId,
                searchQueries,
                onWarning: (message) => limitations.push(message),
              },
              this.config,
              controller.signal,
            );
            check();
            this.workspace.saveCapture(input.threadId, {
              sample: false,
              text:
                sources
                  .map((page) => `${page.title}\n${page.url}\n${page.text}`)
                  .join('\n\n') +
                (limitations.length
                  ? `\n\nSource limitations: ${limitations.join(' ')}`
                  : ''),
              sources: sources.map((page) => ({
                title: page.title,
                url: page.url,
                excerpt: page.text.slice(0, 320),
              })),
            });
            const pages = sources.map((page) =>
              summarizePage(cachePage(page.title, page.url, page.text)),
            );
            return { pages, limitations };
          };
          tools.push(
            defineTool({
              name: 'search_web',
              description:
                'Search public web sources for a research question. Returns a compact outline and a short head excerpt per source with a pageId; use read_page_slice or grep_page to read more. Return source URLs for citations. Sends the question to Parallel.',
              parameters: z.object({
                objective: z.string().min(1).max(4000),
                search_queries: z
                  .array(z.string().min(1).max(200))
                  .min(1)
                  .max(3)
                  .describe(
                    'One to three concise keyword queries, ideally 3–6 words each.',
                  ),
              }),
              execute: ({ objective, search_queries }) =>
                capture(objective, undefined, search_queries),
            }),
            defineTool({
              name: 'read_public_page',
              description:
                'Read a public HTTP(S) URL with Parallel. Returns a compact outline and a short head excerpt with a pageId; use read_page_slice or grep_page to read more. No authenticated browsing or write actions.',
              parameters: z.object({ url: z.string().url().max(2048) }),
              execute: ({ url }) =>
                capture('Read the page for relevant source evidence.', [url]),
            }),
          );
        }
        if (dot.researchAllowed && initialSettings.researchAllowed) {
          tools.push(
            defineTool({
              name: 'read_page_slice',
              description:
                'Read a line range from a page previously returned by read_public_page or search_web, using its pageId. Prefer this to re-fetching a URL.',
              parameters: z.object({
                pageId: z.string(),
                from: z.number().int().min(1).describe('First line, 1-based.'),
                to: z
                  .number()
                  .int()
                  .min(1)
                  .optional()
                  .describe('Last line, inclusive. Defaults to 120 lines.'),
              }),
              execute: async ({ pageId, from, to }) => {
                check();
                return slicePage(pageId, from, to);
              },
            }),
            defineTool({
              name: 'grep_page',
              description:
                'Search a page previously returned by read_public_page or search_web for a keyword, using its pageId. Returns matching line numbers for read_page_slice.',
              parameters: z.object({
                pageId: z.string(),
                query: z.string().min(1).max(200),
              }),
              execute: async ({ pageId, query }) => {
                check();
                return grepPage(pageId, query);
              },
            }),
          );
        }
        // Recall tools only appear once a truncated tool result was archived in
        // an earlier turn (saves schema tokens otherwise).
        if (hasArchives(input.threadId)) {
          const recallExecute = async ({ id }: { id: string }) => {
            check();
            const entry = recallArchived(id);
            if (!entry)
              throw new Error(
                'Unknown or expired archive id. Read it again instead.',
              );
            return {
              id: entry.id,
              label: entry.label,
              text: entry.text.slice(0, 20000),
            };
          };
          tools.push(
            defineTool({
              name: 'recall',
              description:
                'Retrieve the full text of a tool result archived earlier because it was too large to keep in context. The id appears in a "[résultat tronqué …]" marker.',
              parameters: z.object({ id: z.string() }),
              execute: recallExecute,
            }),
            // Phase 9 : alias Magic Compact pour le contenu omis.
            defineTool({
              name: 'read_omitted_content',
              description:
                'Retrieve omitted tool I/O archived during Magic Compact compaction. The id appears in a "[contenu omis …]" marker.',
              parameters: z.object({ id: z.string() }),
              execute: recallExecute,
            }),
            defineTool({
              name: 'recall_search',
              description:
                'Search tool results archived earlier in this conversation for a keyword, returning matching ids to recall.',
              parameters: z.object({
                query: z.string().min(1).max(200),
              }),
              execute: async ({ query }) => {
                check();
                const matches = searchArchived(input.threadId, query).map(
                  (entry) => ({
                    id: entry.id,
                    label: entry.label,
                    excerpt: entry.text.slice(0, 240),
                  }),
                );
                return {
                  matches,
                  note: matches.length
                    ? 'Use recall(id=…) for the full text.'
                    : 'No archived result matched. Try a shorter keyword.',
                };
              },
            }),
          );
        }
        // Owner approval happens in the web app's chat, so channel turns and
        // headless runs cannot use approval-gated connection tools.
        const clientTools = this.channel
          ? []
          : input.tools.filter((tool) =>
              [pageReviewTool.name, connectionActionTool.name].includes(
                tool.name,
              ),
            );
        const approvals = clientTools.some(
          (tool) => tool.name === connectionActionTool.name,
        );
        const connected = connectionTools(
          new ConnectionService(this.workspace.connections),
          dot.id,
          input.threadId,
          check,
          controller.signal,
          approvals,
        );
        const pages = pageAccess(
          this.workspace,
          dot.spaceId,
          input.threadId,
          check,
        );
        const pageContext = pages.context();
        const memories =
          initialSettings.memoryAllowed && dot.memoryAllowed
            ? this.store.memories().map((memory) => memory.text)
            : [];
        // Phase 8 (Operator natif) : consulte le cerveau au démarrage
        // (synchrone : fichiers locaux, cf. consultBrainSync).
        const brainSummary =
          initialSettings.memoryAllowed && dot.memoryAllowed
            ? consultBrainSync(memories)
            : 'aucun';
        // --- Reasoning capture -------------------------------------------------
        // Tee the provider SSE stream for reasoning deltas and re-emit them as
        // AG-UI REASONING_* events. If the provider emits no reasoning, nothing
        // is emitted and the client panel never opens.
        const reasoningMessageId = `reasoning-${input.threadId}-${Date.now()}`;
        // The TanStack adapter also emits its own reasoning message, but it
        // never closes it, which left the AG-UI stream malformed and swallowed
        // the assistant reply. We emit the canonical reasoning events from the
        // SSE tee below and drop the adapter's duplicates in the subscription.
        let reasoningLive = false;
        let reasoningClosed = false;
        const emitReasoning = (event: BaseEvent) => {
          if (finished || reasoningClosed) return;
          try {
            subscriber.next(event);
          } catch {
            // Subscriber gone; the teardown below closes the phase.
          }
        };
        closeReasoning = () => {
          if (!reasoningLive || reasoningClosed) return;
          reasoningClosed = true;
          emitReasoning({
            type: EventType.REASONING_MESSAGE_END,
            messageId: reasoningMessageId,
          });
          emitReasoning({ type: EventType.REASONING_END });
        };
        const reasoningHooks = {
          onStart: () => {
            reasoningLive = true;
            emitReasoning({
              type: EventType.REASONING_START,
              messageId: reasoningMessageId,
            });
            emitReasoning({
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningMessageId,
              role: 'reasoning',
            });
          },
          onDelta: (text: string) => {
            emitReasoning({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: reasoningMessageId,
              delta: text,
            });
          },
          onAnswerStart: () => closeReasoning(),
          onEnd: (info: {
            promptTokens: number | null;
            completionTokens: number | null;
            durationMs: number;
          }) => {
            const stats = buildReasoningStats(model, info);
            saveReasoningStats(reasoningMessageId, stats);
            closeReasoning();
          },
        };
        const previousFetch = globalThis.fetch;
        const chatCompletionsUrl = baseUrl
          .replace(/\/$/, '')
          .concat('/chat/completions');
        const isChatCompletions = (url: string) =>
          url.startsWith(chatCompletionsUrl);
        const reasoningFetch = createReasoningFetch(
          previousFetch,
          isChatCompletions,
          reasoningHooks,
        );
        // Classify provider/model HTTP failures into actionable messages while
        // preserving abort signals and non-model errors untouched.
        globalThis.fetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          try {
            const response = await reasoningFetch(input as never, init);
            if (isChatCompletions(url) && !response.ok) {
              const body = await response
                .clone()
                .text()
                .catch(() => '');
              throw new Error(
                `${response.status} ${body}`
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 600),
              );
            }
            return response;
          } catch (requestError) {
            const aborted =
              Boolean(init?.signal?.aborted) ||
              (requestError instanceof Error &&
                requestError.name === 'AbortError');
            if (!isChatCompletions(url) || aborted) throw requestError;
            throw new Error(classifyModelError(requestError), {
              cause: requestError,
            });
          }
        }) as typeof fetch;
        const wrappedFetch = globalThis.fetch;
        restoreFetch = () => {
          if (globalThis.fetch === wrappedFetch)
            globalThis.fetch = previousFetch;
        };
        // --- End reasoning capture ---------------------------------------------
        const adapter = openaiCompatibleText(model, {
          apiKey,
          baseURL: baseUrl,
          api: 'chat-completions',
          maxRetries: 1,
        });
        const serverTools = [
          ...tools,
          ...pageTools(pages),
          ...brainTools(),
          ...(computer.configured
            ? computerTools(computer, dot.id, check, controller.signal)
            : []),
          ...(this.config.externalAccounts
            ? externalAccountTools(
                this.config.externalAccounts,
                check,
                controller.signal,
              )
            : []),
        ];
        const externalServices =
          this.config.externalAccounts?.callableServices() ?? [];
        const prompt = buildSystemPrompt({
          dotName: dot.name,
          instructions: dot.instructions,
          memories,
          brainSummary,
          page: pageContext,
          computerConfigured: computer.configured,
          connectedCount: connected.length,
          connectionActionToolName: connectionActionTool.name,
          externalServices: externalServices.map((s) => s.name),
          spaceId: dot.spaceId,
        });
        this.inner = new BuiltInAgent({
          type: 'tanstack',
          factory: async (ctx) => {
            check();
            // Phase 9 : stratégie de compaction par Dot (défaut : native).
            const compact =
              dot.compactionStrategy === 'magic-compact'
                ? magicCompactMessages
                : compactMessages;
            const compacted = await compact(
              ctx.input.messages as ChatMessage[],
              {
                threadId: input.threadId,
                model,
                apiKey: apiKey ?? '',
                baseUrl,
                // Phase 6 : budget par Dot (chat général 8K–32K) ;
                // null = agentique → contexte natif maximal (256K+).
                contextWindow:
                  dot.contextBudget ??
                  Math.max(this.config.contextWindow ?? 0, 256000),
                fetchImpl: previousFetch,
                signal: ctx.abortSignal,
              },
            );
            check();
            // Phase 5 : injecte les images jointes comme parties multimodales
            // dans le dernier message utilisateur (avant conversion TanStack).
            const withImages = await injectAttachedImages(
              compacted.messages as ChatMessage[],
            );
            check();
            const converted = convertInputToTanStackAI({
              ...ctx.input,
              // Match BuiltInAgent's default trust boundary for client messages.
              messages: (withImages as RunAgentInput['messages'])
                .filter(
                  (message) =>
                    message.role !== 'system' && message.role !== 'developer',
                )
                .map((message) => {
                  if (
                    message.role !== 'tool' ||
                    typeof message.content !== 'string' ||
                    message.content.length <= TOOL_RESULT_LIMIT
                  )
                    return message;
                  const key =
                    (message as { id?: string }).id ?? message.content;
                  const { id } = archiveResult(
                    input.threadId,
                    key,
                    'tool result',
                    message.content,
                  );
                  return {
                    ...message,
                    content: `${message.content.slice(0, TOOL_RESULT_LIMIT)}\n…[résultat tronqué — contenu complet archivé sous l’id "${id}", utilise recall(id="${id}")]`,
                  };
                }),
            });
            return chat({
              adapter,
              messages: converted.messages,
              systemPrompts: [prompt, ...converted.systemPrompts],
              abortController: ctx.abortController,
              threadId: ctx.input.threadId,
              runId: ctx.input.runId,
              modelOptions: {
                max_completion_tokens: 2200,
                // Thinking off by default for speed; the composer toggle can
                // raise it to 'low'/'high' per Dot. LiteLLM drops the field for
                // models that do not support it.
                reasoning_effort: dot.reasoningEffort ?? 'none',
              },
              agentLoopStrategy: maxIterations(5),
              // Phase 5a : injecte les screenshots computer comme images.
              middleware: [screenshotMiddleware(dot.id)],
              tools: [
                ...tanstackTools(serverTools),
                ...connected,
                ...converted.tools,
              ],
            });
          },
        });
        subscription = this.inner
          .run({
            ...input,
            tools: [
              ...(clientTools.some((tool) => tool.name === pageReviewTool.name)
                ? [pageReviewTool]
                : []),
              ...(approvals ? [connectionActionTool] : []),
            ],
            forwardedProps: {},
          })
          .subscribe({
            next: (event) => {
              // Drop the adapter's own REASONING_* events: our SSE tee already
              // emits the canonical, well-closed reasoning message. The
              // adapter's copy left a message open and broke the assistant
              // reply downstream.
              if (String(event.type).startsWith('REASONING')) return;
              if (controller.signal.aborted)
                observe({ type: EventType.RUN_ERROR });
              observe(event);
              if (
                event.type === EventType.RUN_ERROR ||
                event.type === EventType.RUN_FINISHED
              )
                finished = true;
              // Phase 3 : dérive des événements d'étape des appels d'outils
              // pour la carte de progression du transcript.
              // (BaseEvent est un schéma passthrough : cast vers les types précis.)
              if (event.type === EventType.TOOL_CALL_START) {
                const start = event as ToolCallStartEvent;
                const label = stepLabelForTool(start.toolCallName);
                stepLabels.set(start.toolCallId, label);
                subscriber.next({
                  type: EventType.STEP_STARTED,
                  stepName: label,
                });
              } else if (event.type === EventType.TOOL_CALL_END) {
                const end = event as ToolCallEndEvent;
                const label = stepLabels.get(end.toolCallId);
                if (label) {
                  stepLabels.delete(end.toolCallId);
                  subscriber.next({
                    type: EventType.STEP_FINISHED,
                    stepName: label,
                  });
                }
              }
              subscriber.next(
                this.channel && event.type === EventType.RUN_ERROR
                  ? channelError()
                  : event,
              );
            },
            error: (error: unknown) => {
              observe({ type: EventType.RUN_ERROR });
              if (this.channel) {
                subscriber.next(channelError());
                subscriber.complete();
              } else if (timedOut && !finished) {
                subscriber.next(timeLimitError());
                subscriber.complete();
              } else subscriber.error(error);
            },
            complete: () => {
              if (controller.signal.aborted && !finished)
                observe({ type: EventType.RUN_ERROR });
              if (timedOut && !finished) {
                observe({ type: EventType.RUN_ERROR });
                subscriber.next(
                  this.channel ? channelError() : timeLimitError(),
                );
              }
              subscriber.complete();
            },
          });
      } catch (error) {
        if (!configurationFailure) observe({ type: EventType.RUN_ERROR });
        subscriber.next(
          this.channel
            ? channelError()
            : {
                type: EventType.RUN_ERROR,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Dot could not start.',
              },
        );
        subscriber.complete();
      }
      return () => {
        clearTimeout(timeout);
        clearInterval(watcher);
        closeReasoning();
        restoreFetch();
        controller.abort();
        this.inner?.abortRun();
        subscription?.unsubscribe();
      };
    });
  }
}
