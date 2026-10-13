import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import { CopilotRuntime, createCopilotHonoHandler } from '@copilotkit/runtime/v2';
import type { Message, RunAgentInput } from '@ag-ui/core';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { currentTurnText } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { SqliteAgentRunner } from './sqlite-runner.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';

export class Platform {
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  readonly runner: SqliteAgentRunner;
  readonly handler: ReturnType<typeof createCopilotHonoHandler>;
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
    // Local-only runtime: a durable SQLite AgentRunner, no hosted Intelligence.
    this.runner = new SqliteAgentRunner(config.databasePath);
    this.pages = new PageService(workspace, () => ({
      getOrCreateThread: async () => ({}),
      getThreadMessages: async ({ threadId }) => ({
        messages: this.runner.getThreadMessages(threadId) as {
          role: string;
          content?: unknown;
        }[],
      }),
    }));
    const runtime = new CopilotRuntime({
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      runner: this.runner,
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
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(this.config);
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length) throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async start() {
    this.setupTelemetry.start();
  }
  async stop() {
    await this.setupTelemetry.stop();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    // The thread id is minted locally and its transcript is stored locally by
    // the runner; no hosted round-trip is needed.
    return this.workspace.bindThread(randomUUID(), dotId, title);
  }
  async deleteConversation(threadId: string): Promise<void> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    this.workspace.deleteThread(threadId);
    this.runner.deleteThread(threadId);
  }
  async deleteAllConversations(): Promise<number> {
    this.requireReady();
    const conversations = this.workspace.conversations();
    for (const conversation of conversations) {
      this.workspace.deleteThread(conversation.id);
      this.runner.deleteThread(conversation.id);
    }
    return conversations.length;
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = this.runner.getThreadMessages(threadId);
    return history
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
    // fork deliberately does not serve; answering 204 stops the retry loop.
    const pathname = new URL(request.url).pathname;
    if (
      request.method === 'GET' &&
      (pathname.endsWith('/inspector-metadata') ||
        pathname.endsWith('/inspector-learning'))
    )
      return new Response(null, { status: 204 });
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
  /**
   * Run a headless turn (scheduled tasks, voice compute) fully in-process
   * through the local runner, persisting it to the thread transcript.
   */
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    signal.throwIfAborted();
    const thread = this.workspace.requireThread(threadId);
    const agent = new DotAgent(
      this.store,
      this.workspace,
      this.config,
      thread.dotId,
      false,
      this.setupTelemetry,
    );
    const idPrefix =
      metadata?.opendotsSource === 'voice_receipt'
        ? voiceReceiptMessagePrefix
        : metadata?.opendotsSource === 'scheduled_task'
          ? scheduledTaskMessagePrefix
          : '';
    const prior = this.runner.getThreadMessages(threadId);
    const messages: Message[] = [
      ...prior,
      {
        id: `${idPrefix}${randomUUID()}`,
        role: 'user',
        content: prompt,
        ...(metadata ? { metadata } : {}),
      } as Message,
    ];
    const input: RunAgentInput = {
      threadId,
      runId: randomUUID(),
      state: {},
      messages,
      tools: [],
      context: [],
    };
    const stop = () => void this.runner.stop({ threadId });
    signal.addEventListener('abort', stop, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.runner
          .run({ threadId, agent, input })
          .subscribe({ error: reject, complete: resolve });
      });
      signal.throwIfAborted();
      return currentTurnText(this.runner.getThreadMessages(threadId));
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
}
