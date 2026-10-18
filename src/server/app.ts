import { computerRoutes } from './computer-routes.js';
import { connectionRoutes } from './connection-routes.js';
import { attachmentRoutes } from './attachment-routes.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { configured, type Config } from './research.js';
import type { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { workspaceRoutes } from './workspace-routes.js';
import { providerRoutes } from './provider-routes.js';
import { externalAccountRoutes } from './external-accounts.js';
import { systemMetrics } from './metrics.js';
import { AuthStore, verifyPasswordOrDummy } from './auth-store.js';
const interval = z.number().int().min(60).max(31_536_000).nullable();
export interface AppOptions {
  store: Store;
  runner: Runner;
  config: Config;
  ownerToken?: string;
  origin?: string | string[];
  platform?: Platform;
  /** Phase A (comptes) : store d'auth. Optionnel : sans lui, /api/auth/* → 503. */
  auth?: AuthStore;
}
/**
 * Valeur Set-Cookie du jeton propriétaire : HttpOnly (illisible par le
 * JS — le point du lot), SameSite=Strict (anti-CSRF), Path=/ (couvre
 * /api et /dots). Secure quand la requête est en https (Origin ou URL).
 * maxAge = 0 efface le cookie (logout).
 */
function authCookie(c: Context, value: string, maxAge?: number): string {
  return (
    `opendots-auth=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict` +
    (isSecureRequest(c) ? '; Secure' : '') +
    (maxAge !== undefined ? `; Max-Age=${maxAge}` : '')
  );
}
/** Cookie de session comptes (Phase A) : il porte un id aléatoire, pas un
 *  secret — la session vit côté serveur (révocable). Mêmes attributs que le
 *  cookie jeton (HttpOnly + SameSite=Strict + Secure si https). */
function sessionCookie(c: Context, value: string, maxAge?: number): string {
  return (
    `nevadots-session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict` +
    (isSecureRequest(c) ? '; Secure' : '') +
    (maxAge !== undefined ? `; Max-Age=${maxAge}` : '')
  );
}
function isSecureRequest(c: Context): boolean {
  return (
    c.req.url.startsWith('https://') ||
    (c.req.header('origin') ?? '').startsWith('https://')
  );
}

/**
 * Clé de rate-limit. X-Forwarded-For n'est lu QUE derrière un reverse-proxy
 * de confiance (TRUST_PROXY=true) : sinon tout client peut forger l'en-tête
 * et faire tourner les buckets. Sans proxy, l'adresse du socket est utilisée
 * (en loopback unique, tout le monde partage le même bucket — arrêt de la
 * rotation XFF, pas de découpage par utilisateur).
 */
function rateLimitKey(c: Context): string {
  if (process.env.TRUST_PROXY === 'true')
    return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const incoming = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming;
  return incoming?.socket?.remoteAddress || 'local';
}
export function createApp({
  store,
  runner,
  config,
  ownerToken,
  origin,
  platform,
  auth,
}: AppOptions) {
  const app = new Hono();
  // Simple per-IP fixed-window rate limit for the API. Generous by default
  // (the UI polls), configurable/tunable via RATE_LIMIT_PER_MIN (0 disables).
  const rateLimit = Number.parseInt(
    process.env.RATE_LIMIT_PER_MIN ?? '1000',
    10,
  );
  const buckets = new Map<string, { count: number; resetAt: number }>();
  // Phase A (comptes) : bucket dédié pour la connexion (5/min/IP) — le
  // bucket général (1000/min) est trop large pour un endpoint de login.
  const LOGIN_RATE_LIMIT_PER_MIN = 5;
  const loginBuckets = new Map<string, { count: number; resetAt: number }>();
  app.use('/api/*', async (c, next) => {
    if (Number.isFinite(rateLimit) && rateLimit > 0) {
      const key = rateLimitKey(c);
      const now = Date.now();
      // Purge opportuniste des fenêtres expirées : une clé forgée ne peut
      // pas faire grossir la Map indéfiniment. Borne dure en taille aussi.
      if (buckets.size > 10_000) {
        for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
      }
      const bucket = buckets.get(key);
      if (!bucket || now > bucket.resetAt)
        buckets.set(key, { count: 1, resetAt: now + 60_000 });
      else if (++bucket.count > rateLimit)
        return c.json({ error: 'Too many requests.' }, 429);
    }
    // Bucket login toujours actif, même si le rate-limit général est désactivé
    // (RATE_LIMIT_PER_MIN=0) : c'est un contrôle anti-brute-force, pas un
    // budget API.
    if (c.req.method === 'POST' && c.req.path === '/api/auth/login') {
      const key = rateLimitKey(c);
      const now = Date.now();
      if (loginBuckets.size > 10_000) {
        for (const [k, b] of loginBuckets)
          if (now > b.resetAt) loginBuckets.delete(k);
      }
      const bucket = loginBuckets.get(key);
      if (!bucket || now > bucket.resetAt)
        loginBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      else if (++bucket.count > LOGIN_RATE_LIMIT_PER_MIN)
        return c.json({ error: 'Too many requests.' }, 429);
    }
    await next();
  });
  const jsonLimit = bodyLimit({
    maxSize: 1_000_000,
    onError: (c) => c.json({ error: 'Request is too large.' }, 413),
  });
  const uploadLimit = bodyLimit({
    maxSize: 60_000_000,
    onError: (c) => c.json({ error: 'Upload is too large.' }, 413),
  });
  app.use('/api/*', (c, next) =>
    c.req.method === 'POST' && c.req.path === '/api/attachments'
      ? uploadLimit(c, next)
      : jsonLimit(c, next),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const requestUrl = new URL(c.req.url);
    const origins = origin
      ? Array.isArray(origin)
        ? origin
        : [origin]
      : undefined;
    const originHostnames = origins
      ? origins
          .map((o) => {
            try {
              return new URL(o).hostname;
            } catch {
              return '';
            }
          })
          .filter(Boolean)
      : [];
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...originHostnames,
    ]);
    if (!ownerToken && !allowedHosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    const allowedOrigins = new Set(origins ?? [new URL(c.req.url).origin]);
    if (requestOrigin && !allowedOrigins.has(requestOrigin))
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    // POST /api/login et /api/auth/* n'ont pas encore de session : ils
    // vérifient leurs propres identifiants (jeton / mot de passe / session)
    // — on saute le contrôle token ici, les gardes host/origin/sec-fetch
    // restent actives.
    const isLogin =
      (c.req.method === 'POST' && c.req.path === '/api/login') ||
      (c.req.method === 'POST' && c.req.path === '/api/auth/login') ||
      (c.req.method === 'POST' && c.req.path === '/api/auth/logout');
    if (ownerToken && !isLogin) {
      const expected = Buffer.from(ownerToken);
      const header = c.req.header('authorization')?.replace(/^Bearer /, '');
      // Le cookie HttpOnly (posé par POST /api/login, illisible par le
      // JS) est accepté pour toutes les routes /api — le navigateur
      // l'envoie automatiquement (y compris <img> et liens de
      // téléchargement, qui ne peuvent pas porter d'en-tête). Défenses
      // CSRF : SameSite=Strict + gardes origin/sec-fetch ci-dessus,
      // comparaison timing-safe.
      const supplied = Buffer.from(
        header ?? getCookie(c, 'opendots-auth') ?? '',
      );
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        return c.json(
          { error: 'Enter your owner access token to unlock NevaDots.' },
          401,
        );
    }
    const contentType = c.req.header('content-type');
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      contentType &&
      !contentType.includes('application/json') &&
      !contentType.includes('multipart/form-data')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  });
  // Auth par cookie HttpOnly : le jeton n'est jamais stocké dans le JS.
  // POST /api/login vérifie le jeton du corps et pose le cookie ;
  // POST /api/logout l'efface. Le middleware ci-dessus saute le
  // contrôle token pour /api/login (pas encore de cookie).
  app.post('/api/auth/login', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const parsed = z
      .object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(256),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter a username and password.' }, 400);
    const ip = rateLimitKey(c);
    const row = auth.getUserByUsername(parsed.data.username);
    // Même message, même vérif (fictive si l'utilisateur n'existe pas) :
    // on ne révèle jamais si le compte existe, ni s'il est désactivé.
    const ok = await verifyPasswordOrDummy(
      parsed.data.password,
      row?.passwordHash ?? null,
    );
    if (!ok || !row || row.disabled) {
      auth.logAuthEvent('login_failed', parsed.data.username, ip);
      return c.json({ error: 'Invalid username or password.' }, 401);
    }
    const { rawId } = auth.createSession(row.id);
    auth.setLastLogin(row.id);
    auth.logAuthEvent('login_ok', row.username, ip);
    c.header('Set-Cookie', sessionCookie(c, rawId));
    return c.json({
      ok: true,
      user: { username: row.username, role: row.role },
    });
  });
  // Déconnexion comptes : idempotente (200 même sans cookie — la session
  // peut déjà être expirée/révoquée). Ne touche jamais au cookie jeton.
  app.post('/api/auth/logout', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const raw = getCookie(c, 'nevadots-session');
    if (raw) auth.revokeSession(raw);
    c.header('Set-Cookie', sessionCookie(c, '', 0));
    return c.json({ ok: true });
  });

  app.post('/api/login', async (c) => {
    const parsed = z
      .object({ token: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter your owner access token.' }, 400);
    if (!ownerToken)
      return c.json({ error: 'Owner authentication is not configured.' }, 400);
    const expected = Buffer.from(ownerToken);
    const supplied = Buffer.from(parsed.data.token);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return c.json({ error: 'Access token was not accepted.' }, 401);
    c.header('Set-Cookie', authCookie(c, ownerToken));
    return c.json({ ok: true });
  });
  app.post('/api/logout', async (c) => {
    c.header('Set-Cookie', authCookie(c, '', 0));
    return c.json({ ok: true });
  });
  if (platform) app.route('/api', computerRoutes(platform.computers));
  app.route('/api', attachmentRoutes());
  if (platform)
    app.route(
      '/api',
      connectionRoutes(platform.workspace, platform.connections),
    );
  const voice = platform ? new VoiceService(platform) : undefined;
  if (platform && voice) app.route('/api', workspaceRoutes(platform, voice));
  if (platform) app.route('/api', providerRoutes(platform));
  if (platform?.config.externalAccounts)
    app.route('/api', externalAccountRoutes(platform.config.externalAccounts));
  app.get('/api/state', (c) =>
    c.json({
      settings: store.settings(),
      tasks: store.tasks(),
      memories: store.memories(),
      mode: config.mode,
      configured: configured(config),
    }),
  );
  app.get('/api/metrics', async (c) => c.json(await systemMetrics()));
  app.post('/api/tasks', async (c) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        intervalSeconds: interval.optional(),
        runAt: z.number().int().positive().optional(),
        threadId: z.string().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
        },
        400,
      );
    if (!store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    if (platform) {
      if (platform.setup().missing.length)
        return c.json(
          { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
          503,
        );
      if (!parsed.data.threadId)
        return c.json(
          { error: 'Select a conversation for this scheduled task.' },
          400,
        );
      try {
        platform.workspace.requireThread(parsed.data.threadId);
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    const task = store.createTask(
      parsed.data.prompt,
      parsed.data.runAt ? null : parsed.data.intervalSeconds,
      parsed.data.runAt ?? null,
    );
    if (platform && parsed.data.threadId)
      platform.workspace.bindTask(task.id, parsed.data.threadId);
    return c.json(task, 201);
  });
  app.get('/api/tasks/:id', (c) => {
    const detail = store.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
  });
  app.post('/api/tasks/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['run', 'pause', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown task action.' }, 400);
    if (parsed.data.action === 'run' && !store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    const task = store.action(c.req.param('id'), parsed.data.action);
    if (parsed.data.action !== 'run') runner.abort(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.put('/api/tasks/:id/schedule', async (c) => {
    const parsed = z
      .object({ intervalSeconds: interval })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Repeat interval must be 60 seconds to one year, or null.' },
        400,
      );
    const task = store.schedule(c.req.param('id'), parsed.data.intervalSeconds);
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.patch('/api/settings', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        paused: z.boolean().optional(),
        researchAllowed: z.boolean().optional(),
        memoryAllowed: z.boolean().optional(),
        replyStyle: z.enum(['concise', 'standard', 'detailed']).optional(),
        replyLanguage: z.enum(['fr', 'auto']).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings.' }, 400);
    const previous = store.settings();
    const settings = store.updateSettings(parsed.data);
    if (
      settings.paused ||
      !settings.researchAllowed ||
      previous.memoryAllowed !== settings.memoryAllowed
    )
      runner.abortAll();
    if (settings.paused) voice?.abortAll();
    else void voice?.resumePending();
    return c.json(settings);
  });
  app.post('/api/memories', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    return c.json(store.saveMemory(parsed.data.text), 201);
  });
  app.put('/api/memories/:id', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    if (!store.memories().some((m) => m.id === c.req.param('id')))
      return c.json({ error: 'Memory not found.' }, 404);
    return c.json(store.saveMemory(parsed.data.text, c.req.param('id')));
  });
  app.delete('/api/memories/:id', (c) =>
    store.deleteMemory(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found.' }, 404),
  );
  // Bulk "forget everything" (double-confirmed client-side).
  app.delete('/api/memories', (c) =>
    c.json({ ok: true, removed: store.deleteAllMemories() }),
  );
  // Aggregated model usage for the settings cockpit.
  app.get('/api/usage', (c) => c.json(store.usageSummary()));
  // Unauthenticated liveness probe: cheap, proves the DB is reachable.
  app.get('/health', (c) => {
    try {
      store.settings();
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'error' }, 503);
    }
  });
  app.onError((error, c) => {
    console.error('API request failed:', error.name);
    return c.json(
      {
        error:
          'The server could not complete this request. Check server logs and database access.',
      },
      500,
    );
  });
  return app;
}
