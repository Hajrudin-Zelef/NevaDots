import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
  type PlatformConfig,
} from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
import { SetupTelemetry } from './setup-telemetry.js';

/** True when an Intelligence request failed for a transient reason worth retrying. */
function isRetryableIntelligenceError(error: unknown): boolean {
  if ((error as { retryable?: unknown })?.retryable === true) return true;
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') return status >= 500 || status === 429;
  // No HTTP status means a transport/timeout failure — worth one more try.
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject if `promise` does not settle within `ms` (the SDK has no timeout). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Intelligence request timed out') as Error & {
        timeout?: boolean;
      };
      error.timeout = true;
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class Platform {
  private channelStartupFailed = false;
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  readonly intelligence?: CopilotKitIntelligence;
  readonly handler?: CopilotHonoApp;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
  ) {
    this.setupTelemetry = new SetupTelemetry(store);
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(workspace.connections);
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.intelligence!;
    });
    if (!config.intelligenceKey) return;
    this.intelligence = new CopilotKitIntelligence({
      apiKey: config.intelligenceKey,
      apiUrl: config.intelligenceApiUrl,
      wsUrl: config.intelligenceWsUrl,
      getLearningContainerId: learningSelector(
        workspace,
        config.slackDotId ?? workspace.dots()[0]?.id,
      ),
    });
    const channels = [];
    if (config.slackChannel && config.slackTeam && config.slackUsers.length) {
      const dotId = config.slackDotId ?? workspace.dots()[0].id;
      if (!workspace.dot(dotId))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: () => store.settings().paused,
        agent: () =>
          new DotAgent(
            store,
            workspace,
            config,
            dotId,
            true,
            this.setupTelemetry,
          ),
      });
      channels.push(slack);
    }
    const runtime = new CopilotRuntime({
      intelligence: this.intelligence,
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'NevaDots owner',
      }),
      agents: async () =>
        Object.fromEntries(
          workspace
            .dots()
            .map((dot) => [
              dot.id,
              new DotAgent(
                store,
                workspace,
                config,
                dot.id,
                false,
                this.setupTelemetry,
              ),
            ]),
        ),
      channels,
      generateThreadNames: true,
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Conversations require CopilotKit Intelligence.`,
      );
  }
  async start() {
    this.setupTelemetry.start();
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        this.setupTelemetry.capture({
          kind: 'setup_failed',
          step: 'settings',
          error_class: 'channel_start_failed',
        });
        throw error;
      }
    }
  }
  async stop() {
    await this.setupTelemetry.stop();
    await this.handler?.channels?.stop();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await withTimeout(
          this.intelligence!.createThread({
            threadId: id,
            userId: this.workspace.ownerId,
            agentId: dotId,
            name: title,
          }),
          6000,
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 3 || !isRetryableIntelligenceError(error)) break;
        await delay(attempt * 600);
      }
    }
    if (lastError !== undefined) {
      const status = (lastError as { status?: unknown }).status;
      const timedOut = (lastError as { timeout?: unknown }).timeout === true;
      if (typeof status === 'number') {
        throw new Error(
          `CopilotKit Intelligence is unavailable right now (${status}). Please try again in a moment.`,
        );
      }
      if (timedOut) {
        throw new Error(
          'CopilotKit Intelligence is unreachable right now. Please try again in a moment.',
        );
      }
      throw new Error(
        'Intelligence could not create this conversation. Check the runtime key and connection.',
      );
    }
    return this.workspace.bindThread(id, dotId, title);
  }
  /** Remove a conversation locally right away; the hosted delete runs in the background. */
  async deleteConversation(threadId: string): Promise<void> {
    this.requireReady();
    const conversation = this.workspace.requireThread(threadId);
    this.workspace.deleteThread(threadId);
    void withTimeout(
      this.intelligence!.deleteThread({
        threadId,
        userId: this.workspace.ownerId,
        agentId: conversation.dotId,
      }),
      6000,
    ).catch(() => {
      // Intelligence may be unreachable; the local binding is already removed.
    });
  }
  async deleteAllConversations(): Promise<number> {
    this.requireReady();
    const conversations = this.workspace.conversations();
    for (const conversation of conversations)
      this.workspace.deleteThread(conversation.id);
    void Promise.allSettled(
      conversations.map((conversation) =>
        withTimeout(
          this.intelligence!.deleteThread({
            threadId: conversation.id,
            userId: this.workspace.ownerId,
            agentId: conversation.dotId,
          }),
          6000,
        ),
      ),
    );
    return conversations.length;
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = await this.intelligence!.getThreadMessages({
      threadId,
      userId: this.workspace.ownerId,
    });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    // The CopilotKit client continuously polls inspector metadata that this
    // fork deliberately does not serve; answering 204 stops the retry loop and
    // the flood of 403s (which otherwise hammers the runtime).
    const pathname = new URL(request.url).pathname;
    if (
      request.method === 'GET' &&
      (pathname.endsWith('/inspector-metadata') ||
        pathname.endsWith('/inspector-learning'))
    )
      return new Response(null, { status: 204 });
    if (!this.handler)
      return Response.json(
        { error: `Setup required: ${INTELLIGENCE_KEY_MISSING_LABEL}.` },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    return runThreadTurn(
      this.config.runtimeUrl,
      this.config.ownerToken
        ? { Authorization: `Bearer ${this.config.ownerToken}` }
        : {},
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
