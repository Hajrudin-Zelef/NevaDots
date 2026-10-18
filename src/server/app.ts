import { computerRoutes } from './computer-routes.js';
import { connectionRoutes } from './connection-routes.js';
import { attachmentRoutes } from './attachment-routes.js';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
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
import {
  AuthStore,
  PASSWORD_MIN_LENGTH,
  resolveAdminMasterPassword,
  verifyPasswordOrDummy,
} from './auth-store.js';
const interval = z.number().int().min(60).max(31_536_000).nullable();
export interface AppOptions {
  store: Store;
  runner: Runner;
  config: Config;
  origin?: string | string[];
  platform?: Platform;
  /** Phase B (comptes) : store d'auth. Sans lui, /api/* → 401 et /api/auth/* → 503. */
  auth?: AuthStore;
}
/** Cookie de session comptes (Phase B : seule auth) : il porte un id
 *  aléatoire, pas un secret — la session vit côté serveur (révocable).
 *  HttpOnly + SameSite=Strict + Secure si https. */
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

/** Champs d'un formulaire urlencoded (pages /login, /reset sans JS). */
async function formFields(
  c: Context,
  fields: string[],
): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = body[field];
    out[field] = typeof value === 'string' ? value : '';
  }
  return out;
}
function hasValidSession(c: Context, auth: AuthStore | undefined): boolean {
  const raw = getCookie(c, 'nevadots-session');
  return Boolean(raw && auth && auth.getSession(raw));
}
/** En-têtes des pages /login et /reset (CSP stricte, no-cache). */
function authHeaders(c: Context) {
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'`,
  );
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
}
const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
/** Pages /login et /reset : autonomes (sans JS, styles intégrés, logo
 *  public). Les messages ne reprennent jamais la valeur brute du query
 *  (seul `?error=1` / `?reset=1` est interprété) : pas d'injection. */
function authPage(
  kind: 'login' | 'reset' | 'bootstrap',
  error?: string,
  reset?: string,
) {
  const isLogin = kind === 'login';
  const title =
    kind === 'login'
      ? 'Connexion'
      : kind === 'reset'
        ? 'Mot de passe oublié'
        : 'Premier compte Admin';
  const message =
    error === '1'
      ? isLogin
        ? 'Nom d’utilisateur ou mot de passe invalide.'
        : kind === 'reset'
          ? 'Code invalide ou expiré, ou mot de passe trop court (12 caractères minimum).'
          : 'Mot de passe maître invalide, ou mot de passe trop court (12 caractères minimum).'
      : reset === '1'
        ? 'Mot de passe changé. Connectez-vous avec votre nouveau mot de passe.'
        : '';
  const form = isLogin
    ? `<form action="/api/auth/login" method="post">
        <label>Nom d’utilisateur<input name="username" type="text" autocomplete="username" required autofocus /></label>
        <label>Mot de passe<input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Se connecter</button>
      </form>
      <p class="links"><a href="/reset">Mot de passe oublié</a> · <a href="/bootstrap">Premier compte Admin</a></p>`
    : kind === 'reset'
      ? `<form action="/api/auth/reset" method="post">
        <label>Code de réinitialisation (donné par l’admin)<input name="token" type="text" autocomplete="one-time-code" required autofocus /></label>
        <label>Nouveau mot de passe (12 caractères minimum)<input name="password" type="password" autocomplete="new-password" required minlength="12" /></label>
        <button type="submit">Changer le mot de passe</button>
      </form>
      <p class="links"><a href="/login">Retour à la connexion</a></p>`
      : `<form action="/api/auth/bootstrap" method="post">
        <label>Mot de passe maître Admin (variable d’environnement)<input name="masterPassword" type="password" autocomplete="off" required autofocus /></label>
        <label>Nom d’utilisateur du premier Admin<input name="username" type="text" autocomplete="username" required /></label>
        <label>Mot de passe du premier Admin (12 caractères minimum)<input name="password" type="password" autocomplete="new-password" required minlength="12" /></label>
        <button type="submit">Créer le compte Admin</button>
      </form>
      <p class="links"><a href="/login">Retour à la connexion</a></p>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NevaDots — ${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaed;font-family:system-ui,-apple-system,sans-serif}main{width:min(92vw,380px)}img{display:block;width:72px;height:72px;margin:0 auto 16px}h1{text-align:center;font-size:22px;margin:0 0 8px}p.sub{text-align:center;color:#9aa0a6;margin:0 0 24px}p.msg{text-align:center;color:#f28b82;min-height:20px}p.msg.ok{color:#81c995}form{display:grid;gap:14px}label{display:grid;gap:6px;font-size:14px}input{padding:11px 12px;border:1px solid #3c4043;border-radius:8px;background:#1f2126;color:#e8eaed;font-size:16px}button{padding:12px;border:0;border-radius:8px;background:#8ab4f8;color:#0f1115;font-size:16px;font-weight:600;cursor:pointer}p.links{text-align:center;margin:16px 0 0}a{color:#8ab4f8}</style>
</head><body><main><img src="/logo.png" alt="" /><h1>${esc(title)}</h1>
<p class="sub">NevaDots</p>
<p class="msg${reset === '1' ? ' ok' : ''}" role="alert">${esc(message)}</p>
${form}</main></body></html>`;
}

/** Phase B : porte pour le statique (index.ts, avant serveStatic).
 *  Chemins publics : /login, /reset, /health, /logo.png, /fonts/*, /api/*
 *  (l'API a sa propre auth). Sans session → redirection /login pour les
 *  navigations, 401 pour les sous-ressources (JS/CSS). */
export function createStaticGate(auth: AuthStore | undefined) {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path === '/login' ||
      path === '/reset' ||
      path === '/bootstrap' ||
      path === '/health' ||
      path === '/logo.png' ||
      path.startsWith('/fonts/') ||
      path.startsWith('/api/')
    ) {
      await next();
      return;
    }
    if (hasValidSession(c, auth)) {
      await next();
      return;
    }
    const dest = c.req.header('sec-fetch-dest');
    if (dest === 'document' || !dest) return c.redirect('/login', 302);
    return c.body(null, 401);
  };
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
  // Phase B (comptes) : bucket dédié pour la connexion + le reset
  // (5/min/IP) — le bucket général (1000/min) est trop large pour des
  // endpoints d'auth.
  const AUTH_RATE_LIMIT_PER_MIN = 5;
  const authBuckets = new Map<string, { count: number; resetAt: number }>();
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
    // Bucket auth toujours actif, même si le rate-limit général est désactivé
    // (RATE_LIMIT_PER_MIN=0) : c'est un contrôle anti-brute-force, pas un
    // budget API.
    if (
      c.req.method === 'POST' &&
      (c.req.path === '/api/auth/login' ||
        c.req.path === '/api/auth/reset' ||
        c.req.path === '/api/auth/bootstrap')
    ) {
      const key = rateLimitKey(c);
      const now = Date.now();
      if (authBuckets.size > 10_000) {
        for (const [k, b] of authBuckets)
          if (now > b.resetAt) authBuckets.delete(k);
      }
      const bucket = authBuckets.get(key);
      if (!bucket || now > bucket.resetAt)
        authBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      else if (++bucket.count > AUTH_RATE_LIMIT_PER_MIN)
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
    if (!allowedHosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    const allowedOrigins = new Set(origins ?? [new URL(c.req.url).origin]);
    if (requestOrigin && !allowedOrigins.has(requestOrigin))
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    // Phase B : seule la session compte. Le cookie nevadots-session est
    // vérifié côté serveur (révocable). Les routes /api/auth/* vérifient
    // leurs propres identifiants (mot de passe / code reset) — on saute
    // le contrôle session pour elles. L'auth par jeton OWNER_TOKEN est
    // retirée (Bearer et /api/login jeton n'existent plus).
    const isAuthRoute =
      c.req.path === '/api/auth/login' ||
      c.req.path === '/api/auth/logout' ||
      c.req.path === '/api/auth/reset' ||
      c.req.path === '/api/auth/bootstrap';
    if (!isAuthRoute) {
      const raw = getCookie(c, 'nevadots-session');
      const session = raw && auth ? auth.getSession(raw) : undefined;
      if (!session) return c.json({ error: 'Authentication required.' }, 401);
    }
    const contentType = c.req.header('content-type');
    // Les formulaires sans JS des pages /login et /reset postent en
    // urlencoded (seulement sur /api/auth/*).
    const isAuthForm =
      isAuthRoute &&
      (contentType ?? '').includes('application/x-www-form-urlencoded');
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      contentType &&
      !contentType.includes('application/json') &&
      !contentType.includes('multipart/form-data') &&
      !isAuthForm
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  });
  // Auth par session : POST /api/auth/login vérifie le mot de passe et
  // pose le cookie de session. Accepte JSON (fetch) ET formulaire
  // urlencoded (page /login sans JS) : le formulaire redirige vers /
  // (succès) ou /login?error=1 (échec), le JSON reçoit une réponse JSON.
  app.post('/api/auth/login', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const isForm = (c.req.header('content-type') ?? '').includes(
      'application/x-www-form-urlencoded',
    );
    const fail = () =>
      isForm
        ? c.redirect('/login?error=1', 302)
        : c.json({ error: 'Invalid username or password.' }, 401);
    const parsed = z
      .object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(256),
      })
      .strict()
      .safeParse(
        isForm
          ? await formFields(c, ['username', 'password'])
          : await c.req.json().catch(() => null),
      );
    if (!parsed.success)
      return isForm
        ? c.redirect('/login?error=1', 302)
        : c.json({ error: 'Enter a username and password.' }, 400);
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
      return fail();
    }
    const { rawId } = auth.createSession(row.id);
    auth.setLastLogin(row.id);
    auth.logAuthEvent('login_ok', row.username, ip);
    c.header('Set-Cookie', sessionCookie(c, rawId));
    if (isForm) return c.redirect('/', 302);
    return c.json({
      ok: true,
      user: { username: row.username, role: row.role },
    });
  });
  // Déconnexion comptes : idempotente (200 même sans cookie — la session
  // peut déjà être expirée/révoquée).
  app.post('/api/auth/logout', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const raw = getCookie(c, 'nevadots-session');
    if (raw) auth.revokeSession(raw);
    c.header('Set-Cookie', sessionCookie(c, '', 0));
    return c.json({ ok: true });
  });
  // Mot de passe oublié : le code à usage unique (donné par l'admin, hors
  // ligne) + le nouveau mot de passe. Succès → code détruit, toutes les
  // sessions de l'utilisateur révoquées, retour à /login (connexion avec
  // le nouveau mot de passe). JSON (fetch) ou formulaire (page /reset).
  app.post('/api/auth/reset', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const isForm = (c.req.header('content-type') ?? '').includes(
      'application/x-www-form-urlencoded',
    );
    const fail = () =>
      isForm
        ? c.redirect('/reset?error=1', 302)
        : c.json({ error: 'Invalid or expired reset code.' }, 401);
    const parsed = z
      .object({
        token: z.string().min(1).max(256),
        password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
      })
      .strict()
      .safeParse(
        isForm
          ? await formFields(c, ['token', 'password'])
          : await c.req.json().catch(() => null),
      );
    if (!parsed.success)
      return isForm
        ? c.redirect('/reset?error=1', 302)
        : c.json(
            {
              error: `Enter a reset code and a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
            },
            400,
          );
    const found = auth.verifyPasswordReset(parsed.data.token);
    const user = found ? auth.getUserById(found.userId) : undefined;
    if (!found || !user) {
      auth.logAuthEvent('reset_failed', 'unknown', rateLimitKey(c));
      return fail();
    }
    await auth.setUserPassword(user.id, parsed.data.password);
    auth.consumePasswordReset(parsed.data.token);
    auth.revokeAllSessions(user.id);
    auth.logAuthEvent('password_reset', user.username, rateLimitKey(c));
    if (isForm) return c.redirect('/login?reset=1', 302);
    return c.json({ ok: true });
  });
  // Qui suis-je (client, menu avatar Phase F) : le middleware a déjà
  // validé la session.
  app.get('/api/auth/me', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const raw = getCookie(c, 'nevadots-session');
    const session = raw ? auth.getSession(raw) : undefined;
    const user = session ? auth.getUserById(session.userId) : undefined;
    if (!user) return c.json({ error: 'Authentication required.' }, 401);
    return c.json({ username: user.username, role: user.role });
  });
  // Bootstrap du premier compte Admin : UNIQUEMENT si aucun compte
  // n'existe (sinon 409). Le mot de passe maître (env, fail-closed au
  // boot) est vérifié en premier — un mot de passe maître faux donne
  // 401 quel que soit l'état du bootstrap (pas d'énumération).
  // JSON (curl) ou formulaire (page /bootstrap sans JS).
  app.post('/api/auth/bootstrap', async (c) => {
    if (!auth)
      return c.json({ error: 'Authentication is not configured.' }, 503);
    const isForm = (c.req.header('content-type') ?? '').includes(
      'application/x-www-form-urlencoded',
    );
    const fail = () =>
      isForm
        ? c.redirect('/bootstrap?error=1', 302)
        : c.json({ error: 'Invalid master password.' }, 401);
    const parsed = z
      .object({
        masterPassword: z.string().min(1).max(256),
        username: z.string().trim().min(1).max(64),
        password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
      })
      .strict()
      .safeParse(
        isForm
          ? await formFields(c, ['masterPassword', 'username', 'password'])
          : await c.req.json().catch(() => null),
      );
    if (!parsed.success)
      return isForm
        ? c.redirect('/bootstrap?error=1', 302)
        : c.json(
            {
              error: `Enter a master password, a username, and a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
            },
            400,
          );
    const master = resolveAdminMasterPassword();
    const supplied = Buffer.from(parsed.data.masterPassword);
    const expected = Buffer.from(master);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      auth.logAuthEvent(
        'bootstrap_failed',
        parsed.data.username,
        rateLimitKey(c),
      );
      return fail();
    }
    if (auth.countUsers() > 0)
      return isForm
        ? c.redirect('/login', 302)
        : c.json({ error: 'An account already exists.' }, 409);
    const user = await auth.createUser(
      parsed.data.username,
      parsed.data.password,
      'admin',
    );
    auth.logAuthEvent('bootstrap_ok', user.username, rateLimitKey(c));
    if (isForm) return c.redirect('/login?bootstrap=1', 302);
    return c.json(
      { ok: true, user: { username: user.username, role: 'admin' } },
      201,
    );
  });
  // Pages /login et /reset : autonomes (sans JS, styles intégrés, logo
  // public) — elles ne dépendent ni de /assets/* ni de /dots/* (verrouillés).
  // Déjà connecté → redirection vers /.
  app.get('/login', (c) => {
    if (hasValidSession(c, auth)) return c.redirect('/', 302);
    authHeaders(c);
    return c.html(
      authPage('login', c.req.query('error'), c.req.query('reset')),
    );
  });
  app.get('/reset', (c) => {
    if (hasValidSession(c, auth)) return c.redirect('/', 302);
    authHeaders(c);
    return c.html(authPage('reset', c.req.query('error')));
  });
  // Page /bootstrap : création du premier compte Admin (uniquement si
  // aucun compte n'existe — sinon redirection vers /login).
  app.get('/bootstrap', (c) => {
    if (!auth) return c.redirect('/login', 302);
    if (auth.countUsers() > 0) return c.redirect('/login', 302);
    authHeaders(c);
    return c.html(authPage('bootstrap', c.req.query('error')));
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
