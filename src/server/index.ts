import { webSearchProvider } from './parallel.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import { getCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { resolveAppOrigins } from './app-origin.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import { ProviderRegistry } from './providers.js';
import { resolveSecretKey } from './secrets.js';
import { attachComputerStream } from './computer-stream.js';
import type { PlatformConfig } from './platform-config.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
const providerRegistry = new ProviderRegistry(
  workspace,
  resolveSecretKey(workspace),
  process.env,
);
const config: PlatformConfig = {
  databasePath: database,
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  models: (process.env.OPENAI_MODELS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  providers: providerRegistry.list(),
  providerRegistry,
  contextWindow: process.env.OPENAI_CONTEXT_WINDOW
    ? Number(process.env.OPENAI_CONTEXT_WINDOW)
    : undefined,
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
};
const platform = new Platform(store, workspace, config);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal, {
      opendotsSource: 'scheduled_task',
    });
    return { text, sources: [], sample: false };
  },
);
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
  platform,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
// Avatar art (/dots) is the owner's private property: it is gated behind the
// owner token (sent as a cookie so <img> can carry it) and refuses cross-site
// embeds, so it can neither be loaded by a stranger nor hotlinked elsewhere.
app.use('/dots/*', async (c, next) => {
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.body(null, 403);
  const referer = c.req.header('referer');
  if (referer) {
    try {
      if (new URL(referer).origin !== new URL(c.req.url).origin)
        return c.body(null, 403);
    } catch {
      return c.body(null, 403);
    }
  }
  if (ownerToken) {
    const supplied =
      getCookie(c, 'opendots-auth') ??
      c.req.header('authorization')?.replace(/^Bearer /, '') ??
      '';
    const expected = Buffer.from(ownerToken);
    const got = Buffer.from(supplied);
    if (expected.length !== got.length || !timingSafeEqual(expected, got))
      return c.body(null, 401);
  }
  await next();
});
// Cache policy: hashed assets are immutable; avatar art (public/dots) is
// private and cache-busted by a version query (see AVATAR_ASSET_VERSION); the
// SPA shell must never be cached, otherwise a stale index.html keeps
// referencing old asset hashes and the browser serves the previous UI after a
// deploy.
app.use('/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  c.header(
    'Cache-Control',
    path.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : path.startsWith('/dots/')
        ? 'private, max-age=300'
        : path.startsWith('/fonts/')
          ? 'public, max-age=604800'
          : 'no-store',
  );
  await next();
});
// Compress only hashed static assets. Scoped to /assets/* so the SSE endpoint
// (/api/copilotkit) and JSON APIs are never buffered or compressed.
app.use('/assets/*', compress({ threshold: 1024 }));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`NevaDots template listening on http://${host}:${info.port}`);
  runner.start();
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Slack Channels activation failed; check setup status',
        [safeFailure(error)],
      ),
    );
});
// Live CDP screencast proxy for the Dot browser (owner-authenticated WebSocket).
attachComputerStream(server, platform.computers, ownerToken);
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: () => platform.stop(),
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
