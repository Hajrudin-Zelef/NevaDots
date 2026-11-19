import { parallelSources } from './parallel.js';
import { pageReviewTool } from '../shared/page-review.js';
import { estimateCostUsd } from '../shared/pricing.js';
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
import {
  compactMessages,
  estimateReserveTokens,
  type ChatMessage,
} from './context-compaction.js';
import { magicCompactMessages } from './magic-compaction.js';
import { searchRag, type RagHit } from './rag.js';
import { readFirstChunk, rebuildResponse } from './ttft.js';
import { modelSupportsTools } from './model-capabilities.js';
import { classifyModelError } from './model-errors.js';
import {
  retargetChatCompletions,
  sameChatTarget,
  shouldFailover,
  type ChatTarget,
} from './model-failover.js';
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
import {
  chat,
  maxIterations,
  type AnyServerTool,
  type ChatMiddleware,
} from '@tanstack/ai';
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
  getReasoningStats,
  saveReasoningStats,
} from './reasoning.js';
import { StepTracker, stepLabelForTool } from './agent-steps.js';
import { pickAutoReasoningEffort } from './reasoning-effort.js';
import { buildSystemPrompt } from './agent-prompt.js';
import { captureExplicitMemory } from './memory-capture.js';
import { suggestSkills } from './skills-routing.js';
import { injectAttachedImages } from './attached-images.js';
import { screenshotMiddleware } from './screenshot-middleware.js';
import { generateFileTool } from './generate-file.js';
import { pdfTools } from './pdf-tools.js';
import { pdfWriteTools } from './pdf-write-tools.js';
import { skillTools } from './skill-tools.js';
import { sessionBrainTools } from './session-brain-tools.js';
import {
  createToolGroupRuntime,
  filterToolCollisions,
  type ToolGroup,
  type ToolGroupState,
} from './tool-groups.js';
import type { SessionBrainStore } from './session-brain.js';
import type { SessionBrainSummarizer } from './session-brain-summarizer.js';
import type { SkillLibrary } from './skills-library.js';
const channelError = () => ({
  type: EventType.RUN_ERROR,
  message:
    'NevaDots could not complete this request. Please check the app and try again.',
});
/** Wall-clock ceiling for one chat turn (env AGENT_TURN_TIMEOUT_MS). */
const DEFAULT_TURN_TIME_LIMIT_MS = 60 * 60_000;
/**
 * Safety cap on model turns inside one chat turn (env
 * AGENT_MAX_ITERATIONS). The loop stops naturally as soon as the model
 * returns a final answer (no tool call); this only guards runaway loops.
 */
const DEFAULT_MAX_AGENT_ITERATIONS = 200;
/** Hard ceiling on the estimated cost of one turn (env AGENT_MAX_TURN_COST_USD). */
const DEFAULT_MAX_TURN_COST_USD = 1;
function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}
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
    private skills?: SkillLibrary,
    private sessionBrains?: SessionBrainStore,
    private sessionSummarizer?: SessionBrainSummarizer,
    private toolGroupState?: ToolGroupState,
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
      this.skills,
      this.sessionBrains,
      this.sessionSummarizer,
      this.toolGroupState,
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
      let costExceeded = false;
      let iterationsExhausted = false;
      let finished = false;
      let configurationFailure = false;
      let sessionNotesBefore: string | undefined;
      let assistantText = '';
      const assistantMessageIds = new Set<string>();
      const turnStartedAt = Date.now();
      const turnUsage = {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        calls: 0,
        resolvedModel: null as string | null,
      };
      const userTurnText = lastUserText(input.messages);
      // Pré-recherche RAG : dernier + avant-dernier message utilisateur, pour
      // résoudre le sujet des questions de suivi (voir ragQueryText).
      const ragQuery = ragQueryText(input.messages);
      // Phase 3 : associe chaque appel d'outil à son libellé d'étape
      // (TOOL_CALL_END ne porte pas le nom de l'outil). Le compteur
      // garantit un protocole équilibré même en cas d'appels parallèles.
      const stepTracker = new StepTracker();
      const observe = answerObserver((event) =>
        this.setupTelemetry?.capture(event),
      );
      const turnTimeLimitMs =
        this.config.turnTimeLimitMs ?? DEFAULT_TURN_TIME_LIMIT_MS;
      const timeout = setTimeout(() => {
        timedOut = true;
        observe({ type: EventType.RUN_ERROR });
        this.abortRun();
      }, turnTimeLimitMs);
      const maxTurnCostUsd =
        this.config.maxTurnCostUsd ?? DEFAULT_MAX_TURN_COST_USD;
      /** Ce qui a été consommé avant l'arrêt (« 42 tours, 0,87 $ estimés »). */
      const consumed = (): string => {
        const parts: string[] = [];
        if (turnUsage.calls > 0)
          parts.push(
            `${turnUsage.calls} tour${turnUsage.calls > 1 ? 's' : ''}`,
          );
        const cost = estimateCostUsd(
          turnUsage.resolvedModel ??
            this.workspace.dot(this.dotId)?.model ??
            '',
          turnUsage.promptTokens,
          turnUsage.completionTokens,
          turnUsage.cachedTokens,
        );
        if (cost != null) parts.push(`${cost.toFixed(2)} $ estimés`);
        return parts.join(', ');
      };
      const timeLimitError = () => {
        const used = consumed();
        return {
          type: EventType.RUN_ERROR,
          message: `Ce tour a atteint la limite de temps (${formatDuration(turnTimeLimitMs)})${used ? ` après ${used}` : ''} et a été arrêté. Dis « continue » pour reprendre, ou découpe la demande.`,
        };
      };
      const costLimitError = () => {
        const used = consumed();
        return {
          type: EventType.RUN_ERROR,
          message: `Ce tour a dépassé la limite de coût (${maxTurnCostUsd.toFixed(2)} $)${used ? ` après ${used}` : ''} et a été arrêté. Dis « continue » pour reprendre, ou augmente AGENT_MAX_TURN_COST_USD.`,
        };
      };
      const iterationsLimitError = () => {
        const used = consumed();
        return {
          type: EventType.RUN_ERROR,
          message: `Ce tour a atteint la limite de tours de modèle${used ? ` (${used})` : ''} et a été arrêté. Dis « continue » pour reprendre, ou découpe la demande.`,
        };
      };
      // Reasoning capture teardown hooks (assigned inside try when used).
      let closeReasoning: () => void = () => {};
      let restoreFetch: () => void = () => {};
      try {
        const dot = this.workspace.dot(this.dotId);
        if (!dot) throw new Error('Specialist Dot not found.');
        // Phase E : limite de consommation mensuelle (dure) — un tour
        // qui démarre alors que la limite est atteinte est refusé.
        const limits = this.workspace.userLimits();
        if (
          limits?.monthlyLimitUsd != null &&
          this.store.monthCostUsd() >= limits.monthlyLimitUsd
        )
          throw new Error('Monthly usage limit reached.');
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
        // Phase E : provider / modèle autorisés pour ce compte (le
        // modèle résolu — explicite ou défaut — doit être autorisé).
        if (
          limits?.allowedProviders &&
          provider &&
          !limits.allowedProviders.includes(provider.id)
        )
          throw new Error(
            `Provider "${provider.id}" is not allowed for this account.`,
          );
        if (
          limits?.allowedModels &&
          model &&
          !limits.allowedModels.includes(model)
        )
          throw new Error(`Model "${model}" is not allowed for this account.`);
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
        const initialSkillsAllowed = this.workspace.skillsAllowed();
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
            current.skillsEnabled !== dot.skillsEnabled ||
            this.workspace.skillsAllowed() !== initialSkillsAllowed ||
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
        // Mémoire explicite (« retiens que… ») : déterministe, sans modèle.
        // Le fait est enregistré avec sa provenance et visible dès ce tour.
        const explicitMemory =
          initialSettings.memoryAllowed && dot.memoryAllowed
            ? captureExplicitMemory(userTurnText)
            : null;
        const savedMemory = explicitMemory
          ? this.store.learnMemory({
              text: explicitMemory,
              threadId: input.threadId,
              messageId: lastUserMessageId(input.messages),
            })
          : null;
        if (savedMemory) memories.push(savedMemory.text);
        // Un Dot est une surface publique : il ne reçoit jamais le cerveau
        // Operator de développement (`.operator`/`~/.operator`). Seules les
        // mémoires SQLite, explicitement autorisées, sont injectées.
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
          onUsage: (info: {
            promptTokens: number | null;
            completionTokens: number | null;
            cachedTokens: number | null;
            resolvedModel: string | null;
          }) => {
            turnUsage.promptTokens += info.promptTokens ?? 0;
            turnUsage.completionTokens += info.completionTokens ?? 0;
            turnUsage.cachedTokens += info.cachedTokens ?? 0;
            turnUsage.calls += 1;
            if (info.resolvedModel)
              turnUsage.resolvedModel = info.resolvedModel;
            // Modèle réellement servi (routeurs) s'il diffère de l'alias
            // demandé ; coût calculé sur le servi quand il est connu.
            // `effectiveTarget` suit une bascule à chaud en cours de tour.
            const servedModel = info.resolvedModel ?? effectiveTarget.model;
            // Une ligne par appel modèle (y compris sans reasoning).
            // messageId opportuniste (souvent null : l'adaptateur n'a
            // pas encore émis les ids) — le RUN_FINISHED relie (F9).
            const servedIds = [...assistantMessageIds];
            try {
              this.store.recordUsage({
                ts: Date.now(),
                dotId: dot.id,
                model: effectiveTarget.model,
                resolvedModel:
                  info.resolvedModel &&
                  info.resolvedModel !== effectiveTarget.model
                    ? info.resolvedModel
                    : null,
                messageId: servedIds.length
                  ? servedIds[servedIds.length - 1]
                  : null,
                promptTokens: info.promptTokens,
                completionTokens: info.completionTokens,
                cachedTokens: info.cachedTokens,
                costUsd: estimateCostUsd(
                  servedModel,
                  info.promptTokens,
                  info.completionTokens,
                  info.cachedTokens,
                ),
              });
            } catch {
              // Usage is best-effort; never break a run on a metrics write.
            }
            const turnCostUsd = estimateCostUsd(
              servedModel,
              turnUsage.promptTokens,
              turnUsage.completionTokens,
              turnUsage.cachedTokens,
            );
            if (
              !costExceeded &&
              turnCostUsd != null &&
              turnCostUsd > maxTurnCostUsd
            ) {
              costExceeded = true;
              console.warn(
                `[agent] turn cost limit reached ($${turnCostUsd.toFixed(4)} > $${maxTurnCostUsd}) for dot ${dot.id}`,
              );
              observe({ type: EventType.RUN_ERROR });
              this.abortRun();
            }
          },
          onEnd: (info: {
            promptTokens: number | null;
            completionTokens: number | null;
            cachedTokens: number | null;
            durationMs: number;
          }) => {
            const stats = buildReasoningStats(effectiveTarget.model, {
              promptTokens:
                turnUsage.calls > 0
                  ? turnUsage.promptTokens
                  : info.promptTokens,
              completionTokens:
                turnUsage.calls > 0
                  ? turnUsage.completionTokens
                  : info.completionTokens,
              cachedTokens:
                turnUsage.calls > 0
                  ? turnUsage.cachedTokens
                  : info.cachedTokens,
              durationMs: info.durationMs,
              resolvedModel: turnUsage.resolvedModel,
            });
            saveReasoningStats(reasoningMessageId, stats);
            // F9 : relie les appels du tour aux messages servis.
            if (assistantMessageIds.size)
              try {
                this.store.bindUsageMessages(
                  [...assistantMessageIds],
                  dot.id,
                  turnStartedAt,
                );
              } catch {
                // Best-effort.
              }
            closeReasoning();
          },
        };
        const previousFetch = globalThis.fetch;
        // Sonde facultative (LiteLLM) démarrée tôt, attendue dans la factory.
        // Fail-open : seuls les modèles explicitement sans outils sont restreints.
        const capabilityPromise = modelSupportsTools({
          providerId: provider?.id,
          baseUrl,
          model,
          apiKey,
          fetchImpl: previousFetch,
          signal: controller.signal,
        });
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
        // Bascule à chaud : le tour est parti avec `model` / `baseUrl`,
        // mais le Dot peut changer de modèle en cours de route (modèle en
        // erreur API, quota épuisé…). On relit la cible courante à chaque
        // requête et on réécrit celle-ci vers elle : le tour continue avec
        // le nouveau modèle, sur le même historique, sans rupture visible.
        let effectiveTarget: ChatTarget = {
          providerId: provider?.id ?? null,
          model: model ?? '',
          apiKey: apiKey ?? '',
          baseUrl,
        };
        const currentTarget = (): ChatTarget | null => {
          const current = this.workspace.dot(this.dotId);
          if (!current) return null;
          const explicit = findProvider(
            this.config.providers,
            current.provider,
          );
          const target =
            explicit ??
            findProvider(this.config.providers, fallbackDefault?.provider) ??
            defaultProvider(this.config.providers);
          const key = target?.apiKey ?? this.config.apiKey;
          const base =
            target?.baseUrl ??
            this.config.baseUrl ??
            'https://api.openai.com/v1';
          const name =
            current.model ??
            (explicit ? explicit.models[0] : fallbackDefault?.model) ??
            this.config.model ??
            target?.models[0];
          return key && name
            ? {
                providerId: target?.id ?? null,
                model: name,
                apiKey: key,
                baseUrl: base,
              }
            : null;
        };
        /** Réécrit la requête si le Dot a changé de modèle depuis le départ. */
        const moveToCurrentModel = (init?: RequestInit) => {
          const target = currentTarget();
          if (!target || sameChatTarget(target, effectiveTarget)) return null;
          const moved = retargetChatCompletions(init, target);
          return moved ? { ...moved, target } : null;
        };
        /**
         * Modèle de secours quand le premier token dépasse `ttftTimeoutMs`.
         * `AGENT_FALLBACK_MODEL` (+ `AGENT_FALLBACK_PROVIDER` optionnel).
         * Absent = pas de bascule TTFT.
         */
        const ttftTimeoutMs = this.config.ttftTimeoutMs ?? 0;
        const fallbackTarget = (): ChatTarget | null => {
          const fallbackModel = this.config.fallbackModel?.trim();
          if (!fallbackModel) return null;
          const providerId =
            this.config.fallbackProvider?.trim() ||
            effectiveTarget.providerId ||
            undefined;
          const target =
            findProvider(this.config.providers, providerId) ??
            findProvider(this.config.providers, fallbackDefault?.provider) ??
            defaultProvider(this.config.providers);
          const key = target?.apiKey ?? this.config.apiKey;
          const base = target?.baseUrl ?? this.config.baseUrl;
          if (!key || !base) return null;
          return {
            providerId: target?.id ?? null,
            model: fallbackModel,
            apiKey: key,
            baseUrl: base,
          };
        };
        const failureText = async (response: Response) => {
          const body = await response
            .clone()
            .text()
            .catch(() => '');
          return `${response.status} ${body}`
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 600);
        };
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
          // Requête de modèle ? (calculé AVANT une éventuelle réécriture,
          // qui change l'URL du provider).
          const isModelCall = isChatCompletions(url);
          let requestInput: RequestInfo | URL = input;
          let requestInit = init;
          if (isModelCall) {
            const moved = moveToCurrentModel(requestInit);
            if (moved) {
              requestInput = moved.url;
              requestInit = moved.init;
              effectiveTarget = moved.target;
            }
          }
          try {
            const response = await reasoningFetch(
              requestInput as never,
              requestInit,
            );
            if (isModelCall && !response.ok) {
              // Échec du provider : si le Dot a changé de modèle, on
              // rejoue la MÊME requête (même historique) sur le nouveau.
              const moved = shouldFailover(response.status)
                ? moveToCurrentModel(requestInit)
                : null;
              if (moved) {
                effectiveTarget = moved.target;
                const retried = await reasoningFetch(
                  moved.url as never,
                  moved.init,
                );
                if (retried.ok) return retried;
                throw new Error(await failureText(retried));
              }
              throw new Error(await failureText(response));
            }
            if (isModelCall && response.ok && ttftTimeoutMs > 0) {
              const fallback = fallbackTarget();
              if (fallback && !sameChatTarget(fallback, effectiveTarget)) {
                const first = await readFirstChunk(response, ttftTimeoutMs);
                if (first.kind === 'timeout') {
                  console.warn(
                    `[model] premier token > ${ttftTimeoutMs} ms — bascule vers ${fallback.model}`,
                  );
                  const moved = retargetChatCompletions(requestInit, fallback);
                  if (moved) {
                    effectiveTarget = fallback;
                    return reasoningFetch(moved.url as never, moved.init);
                  }
                }
                return rebuildResponse(response, first);
              }
            }
            return response;
          } catch (requestError) {
            const aborted =
              Boolean(init?.signal?.aborted) ||
              (requestError instanceof Error &&
                requestError.name === 'AbortError');
            if (!isModelCall || aborted) throw requestError;
            // Panne réseau (DNS, connexion refusée, flux coupé) : si le
            // Dot a changé de modèle, le nouveau provider est peut-être
            // joignable — on rejoue une fois avant d'abandonner.
            const moved = moveToCurrentModel(requestInit);
            if (moved) {
              effectiveTarget = moved.target;
              try {
                return await reasoningFetch(moved.url as never, moved.init);
              } catch (retryError) {
                throw new Error(classifyModelError(retryError), {
                  cause: retryError,
                });
              }
            }
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
        // Un fichier produit (generate_file, pdf_edit/ocr) doit être
        // immédiatement rattaché au compte : sans claim, le lien de
        // téléchargement répond 404 (C2 : une pièce sans propriétaire).
        const claimAttachment = (attachmentId: string) => {
          const userId = this.store.userId;
          if (userId) this.store.claimAttachment(attachmentId, userId);
        };
        // Fail-closed : flag du Dot ET politique admin (kill switch +
        // allowlist). Réévalué à chaque appel d'outil et par le watcher.
        const skillsAllowed = () =>
          !!this.workspace.dot(dot.id)?.skillsEnabled &&
          this.workspace.skillsAllowed();
        // Le watcher aborte le run si le flag ou la politique change : figer
        // ici permet de retirer réellement les outils du schéma quand OFF.
        const skillsActive = skillsAllowed();
        const coreServerTools: ToolDefinition[] = [
          ...pageTools(pages),
          ...(this.sessionBrains
            ? sessionBrainTools(
                this.sessionBrains,
                {
                  userId: dot.userId,
                  dotId: dot.id,
                  threadId: input.threadId,
                },
                check,
              )
            : []),
          ...generateFileTool(claimAttachment),
        ];
        const groupServerTools: Partial<Record<ToolGroup, ToolDefinition[]>> = {
          research: tools,
          pdf: [
            ...pdfTools(dot.id, controller.signal),
            ...pdfWriteTools(controller.signal, claimAttachment),
          ],
          computer: computer.configured
            ? computerTools(
                computer,
                dot.id,
                check,
                controller.signal,
                computer.policy(dot.id),
                claimAttachment,
              )
            : [],
          external: this.config.externalAccounts
            ? externalAccountTools(
                this.config.externalAccounts,
                check,
                controller.signal,
              )
            : [],
          skills:
            this.skills && skillsActive
              ? skillTools(this.skills, {
                  computer,
                  dotId: dot.id,
                  signal: controller.signal,
                  bundleBaseUrl: this.config.computerHostUrl,
                  isEnabled: skillsAllowed,
                  onLoad: (skillId) =>
                    this.workspace.recordSkillLoad(dot.id, skillId),
                })
              : [],
        };
        const coreTanstack = tanstackTools(coreServerTools);
        const groupTanstack: Partial<Record<ToolGroup, AnyServerTool[]>> = {};
        for (const group of [
          'research',
          'pdf',
          'computer',
          'external',
          'skills',
        ] as const) {
          const definitions = groupServerTools[group] ?? [];
          if (definitions.length)
            groupTanstack[group] = tanstackTools(definitions);
        }
        if (connected.length) groupTanstack.mcp = connected;
        const groupSet = filterToolCollisions(coreTanstack, groupTanstack);
        if (
          this.toolGroupState &&
          /\[PDF joint/i.test(userTurnText) &&
          groupSet.available.includes('pdf')
        )
          this.toolGroupState.load(input.threadId, ['pdf']);
        const toolGroupRuntime = this.toolGroupState
          ? createToolGroupRuntime(
              this.toolGroupState,
              input.threadId,
              groupSet,
            )
          : undefined;
        const allGroupTools = Object.values(groupSet.groups).flat();
        const externalServices =
          this.config.externalAccounts?.callableServices() ?? [];
        // Corpus : une seule recherche par tour, fail-open (jamais bloquant).
        // null = pas encore tenté ; [] = tenté sans couverture.
        let ragDocuments: RagHit[] | null = null;
        this.inner = new BuiltInAgent({
          type: 'tanstack',
          factory: async (ctx) => {
            check();
            const toolsAllowed = (await capabilityPromise) !== false;
            let sessionNotes: string | undefined;
            if (this.sessionBrains) {
              const scope = {
                userId: dot.userId,
                dotId: dot.id,
                threadId: input.threadId,
              };
              try {
                sessionNotesBefore = await this.sessionBrains.read(scope);
                sessionNotes = (await this.sessionBrains.promptNotes(scope))
                  .text;
              } catch {
                // Le cerveau de session ne doit jamais casser un tour.
                sessionNotesBefore = '';
                sessionNotes = '';
              }
            }
            if (ragDocuments === null) {
              ragDocuments = [];
              if (dot.documentsEnabled) {
                if (!this.config.ragUrl) {
                  console.warn(
                    `[corpus] ${dot.name}: documentsEnabled mais RAG_URL absent — aucun corpus`,
                  );
                } else if (ragQuery.trim()) {
                  try {
                    const rag = await searchRag(
                      ragQuery,
                      this.config,
                      controller.signal,
                    );
                    if (rag.covered) {
                      ragDocuments = rag.hits;
                      console.info(
                        `[corpus] ${dot.name}: ${rag.hits.length} extrait(s) injecté(s) (version ${rag.corpusVersion})`,
                      );
                    } else {
                      console.debug(
                        `[corpus] ${dot.name}: pas d'injection (non couvert)`,
                      );
                    }
                  } catch (error) {
                    console.error(
                      `[corpus] ${dot.name}: pré-recherche échouée: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                } else {
                  console.debug(
                    `[corpus] ${dot.name}: tour sans texte — pas de pré-recherche`,
                  );
                }
              }
            }
            const prompt = buildSystemPrompt({
              dotName: dot.name,
              instructions: dot.instructions,
              memories,
              sessionNotes,
              page: pageContext,
              computerConfigured: computer.configured,
              connectedCount: connected.length,
              connectionActionToolName: connectionActionTool.name,
              externalServices: externalServices.map((s) => s.name),
              spaceId: dot.spaceId,
              skillsAvailable:
                toolsAllowed && (this.skills?.size ?? 0) > 0 && skillsActive,
              // Routeur auto : suggestions calculées sur le texte du tour
              // (donnée, le modèle tranche). Vide sur les banalités.
              suggestedSkills:
                toolsAllowed && (this.skills?.size ?? 0) > 0 && skillsActive
                  ? suggestSkills(userTurnText)
                  : [],
              toolsAvailable: toolsAllowed,
              memorySaved: savedMemory !== null,
              lazyToolGroups:
                toolsAllowed && toolGroupRuntime ? groupSet.available : [],
              replyStyle: initialSettings.replyStyle,
              replyLanguage: initialSettings.replyLanguage,
              documents: ragDocuments ?? [],
            });
            // Phase 9 : stratégie de compaction par Dot (défaut : native).
            const compact =
              dot.compactionStrategy === 'magic-compact'
                ? magicCompactMessages
                : compactMessages;
            // Réserve calculée une seule fois ; compactionBudgets la soustrait
            // une seule fois (jamais de fenêtre pré-réduite).
            const middleware = (
              toolsAllowed && toolGroupRuntime
                ? [toolGroupRuntime.middleware, screenshotMiddleware(dot.id)]
                : [screenshotMiddleware(dot.id)]
            ) as [ChatMiddleware, ...ChatMiddleware[]];
            const reserveTokens = estimateReserveTokens(
              prompt,
              toolsAllowed
                ? [
                    ...coreServerTools,
                    ...Object.values(groupServerTools).flat(),
                    ...connected,
                    ...ctx.input.tools,
                  ]
                : [],
            );
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
                reserveTokens,
                fetchImpl: previousFetch,
                signal: ctx.abortSignal,
              },
            );
            check();
            // Phase 5 : injecte les images jointes comme parties multimodales
            // dans le dernier message utilisateur (avant conversion TanStack).
            const withImages = await injectAttachedImages(
              compacted.messages as ChatMessage[],
              // C2 : le store porté par le Dot → seules ses images.
              this.store,
            );
            check();
            const converted = convertInputToTanStackAI({
              ...ctx.input,
              // H2 : le convertisseur promeut `context` et `state` en prompts
              // système (contournement du filtre system/developer ci-dessous).
              // Supprimés ici : seul le system prompt serveur s'applique ; un
              // RunAgentInput forgé ne peut rien y injecter.
              context: [],
              state: undefined,
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
            const maxAgentIterations =
              this.config.maxAgentIterations ?? DEFAULT_MAX_AGENT_ITERATIONS;
            const loopStrategy = maxIterations(maxAgentIterations);
            return chat({
              adapter,
              messages: converted.messages,
              systemPrompts: [prompt, ...converted.systemPrompts],
              abortController: ctx.abortController,
              threadId: ctx.input.threadId,
              runId: ctx.input.runId,
              modelOptions: {
                // 2200 tronquait les gros arguments d'outils en plein JSON
                // (fichiers > ~7 Ko) : le tour échouait. 8192 par défaut,
                // surchargeable via MAX_COMPLETION_TOKENS.
                max_completion_tokens: this.config.maxCompletionTokens ?? 8192,
                // `null` (Standard) = Défaut auto : heuristique déterministe
                // sur la requête (voir reasoning-effort.ts). LiteLLM ignore
                // le champ pour les modèles qui ne le supportent pas.
                reasoning_effort:
                  dot.reasoningEffort == null || dot.reasoningEffort === 'auto'
                    ? pickAutoReasoningEffort(userTurnText)
                    : dot.reasoningEffort,
              },
              agentLoopStrategy: (state) => {
                const shouldContinue = loopStrategy(state);
                if (!shouldContinue) {
                  iterationsExhausted = true;
                  console.warn(
                    `[agent] max iterations reached (${maxAgentIterations}) for dot ${dot.id}`,
                  );
                }
                return shouldContinue;
              },
              // Phase 5a : injecte les screenshots computer comme images.
              middleware,
              tools: toolsAllowed
                ? [
                    ...groupSet.core,
                    ...(toolGroupRuntime
                      ? tanstackTools([toolGroupRuntime.loader])
                      : allGroupTools),
                    ...converted.tools,
                  ]
                : [],
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
              if (
                event.type === EventType.TEXT_MESSAGE_START ||
                event.type === EventType.TEXT_MESSAGE_CONTENT ||
                event.type === EventType.TEXT_MESSAGE_CHUNK
              ) {
                const messageId = (event as { messageId?: unknown }).messageId;
                if (typeof messageId === 'string')
                  assistantMessageIds.add(messageId);
              }
              if (
                event.type === EventType.TEXT_MESSAGE_CONTENT ||
                event.type === EventType.TEXT_MESSAGE_CHUNK
              ) {
                const delta = (event as { delta?: unknown }).delta;
                if (typeof delta === 'string') assistantText += delta;
              }
              if (controller.signal.aborted)
                observe({ type: EventType.RUN_ERROR });
              observe(event);
              if (
                event.type === EventType.RUN_ERROR ||
                event.type === EventType.RUN_FINISHED
              ) {
                if (
                  event.type === EventType.RUN_FINISHED &&
                  !finished &&
                  turnUsage.calls > 0
                ) {
                  const stats = buildReasoningStats(effectiveTarget.model, {
                    promptTokens: turnUsage.promptTokens,
                    completionTokens: turnUsage.completionTokens,
                    cachedTokens: turnUsage.cachedTokens,
                    durationMs: Date.now() - turnStartedAt,
                    resolvedModel: turnUsage.resolvedModel,
                  });
                  const ids = assistantMessageIds.size
                    ? assistantMessageIds
                    : new Set([reasoningMessageId]);
                  for (const id of ids)
                    if (!getReasoningStats(id)) saveReasoningStats(id, stats);
                  // F9 : relie les appels du tour aux messages servis.
                  if (assistantMessageIds.size)
                    try {
                      this.store.bindUsageMessages(
                        [...assistantMessageIds],
                        dot.id,
                        turnStartedAt,
                      );
                    } catch {
                      // Best-effort.
                    }
                }
                if (
                  event.type === EventType.RUN_FINISHED &&
                  !finished &&
                  sessionNotesBefore !== undefined
                ) {
                  const brains = this.sessionBrains;
                  const summarizer = this.sessionSummarizer;
                  if (brains && summarizer) {
                    const before = sessionNotesBefore;
                    const scope = {
                      userId: dot.userId,
                      dotId: dot.id,
                      threadId: input.threadId,
                    };
                    const reply = assistantText;
                    void brains
                      .read(scope)
                      .then((current) => {
                        if (current !== before) return;
                        summarizer.schedule({
                          store: brains,
                          scope,
                          beforeNotes: before,
                          userText: userTurnText,
                          assistantText: reply,
                          // Cible courante : le résumé suit une bascule
                          // de modèle faite pendant le tour.
                          model: effectiveTarget.model,
                          baseUrl: effectiveTarget.baseUrl,
                          apiKey: effectiveTarget.apiKey,
                          fetchImpl: previousFetch,
                          onUsage: (usage) => {
                            try {
                              this.store.recordUsage({
                                ts: Date.now(),
                                dotId: dot.id,
                                model: effectiveTarget.model,
                                promptTokens: usage.promptTokens,
                                completionTokens: usage.completionTokens,
                                cachedTokens: 0,
                                costUsd: estimateCostUsd(
                                  effectiveTarget.model,
                                  usage.promptTokens,
                                  usage.completionTokens,
                                  0,
                                ),
                              });
                            } catch {
                              // Usage best-effort.
                            }
                          },
                        });
                      })
                      .catch(() => {
                        // Le résumé automatique est optionnel.
                      });
                  }
                }
                finished = true;
                // Solde les étapes restées actives (fins d'outils manquées) :
                // le protocole reste équilibré pour le run suivant.
                for (const step of stepTracker.drain())
                  subscriber.next({
                    type: EventType.STEP_FINISHED,
                    stepName: step.stepName,
                    // Lot 4 : l'appariement fin/début se fait par toolCallId
                    // (et non plus par libellé). Les schémas AG-UI sont en
                    // `passthrough` : `metadata` traverse le transport sans
                    // nouvelle route ni nouveau protocole (F1 respecté).
                    metadata: {
                      ndStep: {
                        toolCallId: step.toolCallId,
                        toolName: step.toolName,
                      },
                    },
                  });
              }
              // Phase 3 : dérive des événements d'étape des appels d'outils
              // pour la carte de progression du transcript.
              // (BaseEvent est un schéma passthrough : cast vers les types précis.)
              if (event.type === EventType.TOOL_CALL_START) {
                const start = event as ToolCallStartEvent;
                const label = stepLabelForTool(start.toolCallName);
                // Les arguments ne sont pas dans TOOL_CALL_START (ils
                // arrivent par TOOL_CALL_ARGS / le transcript) : le résumé
                // typé est calculé côté client depuis `message.toolCalls[]`
                // — le serveur ne transmet ici que l'identité de l'appel.
                const started = stepTracker.start(
                  start.toolCallId,
                  label,
                  start.toolCallName,
                );
                if (started.length)
                  subscriber.next({
                    type: EventType.STEP_STARTED,
                    stepName: label,
                    metadata: {
                      ndStep: {
                        toolCallId: start.toolCallId,
                        toolName: start.toolCallName,
                      },
                    },
                  });
              } else if (event.type === EventType.TOOL_CALL_END) {
                const end = event as ToolCallEndEvent;
                for (const step of stepTracker.end(end.toolCallId))
                  subscriber.next({
                    type: EventType.STEP_FINISHED,
                    stepName: step.stepName,
                    metadata: {
                      ndStep: {
                        toolCallId: step.toolCallId,
                        toolName: step.toolName,
                      },
                    },
                  });
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
              } else if (costExceeded && !finished) {
                subscriber.next(costLimitError());
                subscriber.complete();
              } else if (iterationsExhausted) {
                subscriber.next(iterationsLimitError());
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
              } else if (costExceeded && !finished) {
                observe({ type: EventType.RUN_ERROR });
                subscriber.next(
                  this.channel ? channelError() : costLimitError(),
                );
              } else if (iterationsExhausted) {
                // Le modèle n'a pas rendu de réponse finale : le tour a été
                // coupé par le plafond de tours, on le dit (avant : un
                // simple console.warn, invisible pour l'utilisateur).
                observe({ type: EventType.RUN_ERROR });
                subscriber.next(
                  this.channel ? channelError() : iterationsLimitError(),
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

function messageText(message: RunAgentInput['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content))
    return message.content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join(' ');
  return '';
}

function lastUserText(messages: RunAgentInput['messages']): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

/** Id du dernier message utilisateur non vide (provenance d'une mémoire). */
function lastUserMessageId(messages: RunAgentInput['messages']): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' || !messageText(message)) continue;
    const id = (message as { id?: unknown }).id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

/**
 * Texte de pré-recherche RAG : les 3 derniers messages utilisateur, plus le
 * premier message substantiel (ancre de sujet) pour que le sujet survive quand
 * la conversation dérive sur plusieurs tours. Sans le message assistant (ses
 * saluts/réponses diluent la requête). Borné à 1200 caractères.
 */
function ragQueryText(messages: RunAgentInput['messages']): string {
  const userTexts: string[] = [];
  let anchor = '';
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = messageText(message).trim();
    if (!text) continue;
    if (!anchor && text.split(/\s+/).length >= 4) anchor = text;
    userTexts.push(text);
  }
  const recent = userTexts.slice(-3);
  const parts =
    anchor && !recent.includes(anchor) ? [anchor, ...recent] : recent;
  return parts.join(' ').slice(0, 1200);
}
