import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import {
  decryptSecret,
  encryptSecret,
  type SecretConfigStore,
} from './secrets.js';

/**
 * External service accounts (GitHub, GitLab, Slack…) that the agent may use.
 * Follows the provider-key pattern: credentials are encrypted at rest and
 * never sent to the frontend; only the public login is exposed.
 * Storage: `external:<id>` → JSON `{fieldsCipher, login, customName?}`.
 */
const STORE_PREFIX = 'external:';

export interface ConnectorField {
  key: string;
  label: string;
  placeholder: string;
  /** Rendered as a visible text input when 'text', masked when 'password'. */
  type: 'text' | 'password';
}

export interface ConnectorAuth {
  headers: Record<string, string>;
  query?: Record<string, string>;
}

export interface ConnectorDef {
  id: string;
  name: string;
  desc: string;
  fields: ConnectorField[];
  /** Live validation; resolves with the display name on success. */
  validate(values: Record<string, string>): Promise<string>;
  /** Base URL for agent-side API calls. Empty when the service exposes no
   * plain HTTP API (MEGA, SFTP) — those cannot be used by the generic tool. */
  apiBase: string;
  /** Builds the auth material from stored credential fields. */
  auth(values: Record<string, string>): ConnectorAuth;
}

type FetchOpts = {
  url: string;
  headers: Record<string, string>;
  body?: string;
};

/** Safely reads a nested string from an unknown JSON value. */
function str(obj: unknown, ...path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
}

async function check(
  opts: FetchOpts,
  extract: (json: unknown) => string,
): Promise<string> {
  const response = await fetch(opts.url, {
    method: opts.body ? 'POST' : 'GET',
    headers: opts.headers,
    body: opts.body,
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error('Non autorisé (vérifiez le token).');
  if (!response.ok) throw new Error(`Le service a répondu ${response.status}.`);
  const json = await response.json().catch(() => null);
  const login = extract(json);
  if (!login) throw new Error('Réponse inattendue du service.');
  return login;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token.trim()}` });

/** TCP reachability check (used for SFTP host/port validation). */
function tcpReachable(host: string, port: number): Promise<void> {
  if (!host) return Promise.reject(new Error('Un hôte est requis.'));
  const target = Number.isFinite(port) && port > 0 ? port : 22;
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port: target });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Hôte injoignable (timeout).'));
    }, 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Connexion impossible : ${err.message}`));
    });
  });
}

const CONNECTOR_DEFS: ConnectorDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    desc: 'Dépôts : clone, commit, push pour l’agent.',
    apiBase: 'https://api.github.com',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Token personnel',
        placeholder: 'ghp_… (scope repo)',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://api.github.com/user',
          headers: {
            ...bearer(v.token),
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NevaDots',
          },
        },
        (j) => str(j, 'login'),
      ),
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    desc: 'Dépôts GitLab pour l’agent.',
    apiBase: 'https://gitlab.com/api/v4',
    auth: (v) => ({ headers: { 'PRIVATE-TOKEN': v.token.trim() } }),
    fields: [
      {
        key: 'token',
        label: 'Token d’accès personnel',
        placeholder: 'glpat-… (scope api)',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://gitlab.com/api/v4/user',
          headers: { 'PRIVATE-TOKEN': v.token.trim() },
        },
        (j) => str(j, 'username'),
      ),
  },
  {
    id: 'slack',
    name: 'Slack',
    desc: 'Lecture et envoi de messages.',
    apiBase: 'https://api.slack.com/api',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        placeholder: 'xoxb-…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://api.slack.com/api/auth.test',
          headers: bearer(v.token),
        },
        (j) =>
          typeof j === 'object' &&
          j !== null &&
          (j as Record<string, unknown>).ok === true
            ? str(j, 'user')
            : '',
      ),
  },
  {
    id: 'discord',
    name: 'Discord',
    desc: 'Lecture et envoi de messages.',
    apiBase: 'https://discord.com/api/v10',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        placeholder: 'Token du bot',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        { url: 'https://discord.com/api/users/@me', headers: bearer(v.token) },
        (j) => str(j, 'username'),
      ),
  },
  {
    id: 'notion',
    name: 'Notion',
    desc: 'Pages et bases de données.',
    apiBase: 'https://api.notion.com/v1',
    auth: (v) => ({
      headers: { ...bearer(v.token), 'Notion-Version': '2022-06-28' },
    }),
    fields: [
      {
        key: 'token',
        label: 'Clé d’intégration',
        placeholder: 'secret_…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://api.notion.com/v1/users/me',
          headers: { ...bearer(v.token), 'Notion-Version': '2022-06-28' },
        },
        (j) => str(j, 'name'),
      ),
  },
  {
    id: 'linear',
    name: 'Linear',
    desc: 'Tickets et projets.',
    apiBase: 'https://api.linear.app/graphql',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Clé API',
        placeholder: 'lin_api_…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://api.linear.app/graphql',
          headers: { ...bearer(v.token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ viewer { displayName } }' }),
        },
        (j) => str(j, 'data', 'viewer', 'displayName'),
      ),
  },
  {
    id: 'stripe',
    name: 'Stripe',
    desc: 'Paiements et factures.',
    apiBase: 'https://api.stripe.com/v1',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Clé secrète',
        placeholder: 'sk_…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        { url: 'https://api.stripe.com/v1/account', headers: bearer(v.token) },
        (j) => str(j, 'display_name') || str(j, 'id'),
      ),
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    desc: 'Fichiers dans le cloud.',
    apiBase: 'https://api.dropboxapi.com/2',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Token d’accès',
        placeholder: 'sl.…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://api.dropboxapi.com/2/users/get_current_account',
          headers: bearer(v.token),
          body: 'null',
        },
        (j) => str(j, 'name', 'display_name'),
      ),
  },
  {
    id: 'trello',
    name: 'Trello',
    desc: 'Tableaux et cartes.',
    apiBase: 'https://api.trello.com/1',
    auth: (v) => ({
      headers: {},
      query: { key: v.key.trim(), token: v.token.trim() },
    }),
    fields: [
      {
        key: 'key',
        label: 'Clé API',
        placeholder: 'Clé API Trello',
        type: 'password',
      },
      {
        key: 'token',
        label: 'Token',
        placeholder: 'Token Trello',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: `https://api.trello.com/1/members/me?key=${encodeURIComponent(v.key.trim())}&token=${encodeURIComponent(v.token.trim())}`,
          headers: {},
        },
        (j) => str(j, 'username'),
      ),
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    desc: 'Modèles et datasets.',
    apiBase: 'https://huggingface.co/api',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      { key: 'token', label: 'Token', placeholder: 'hf_…', type: 'password' },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://huggingface.co/api/whoami-v2',
          headers: bearer(v.token),
        },
        (j) => str(j, 'name'),
      ),
  },
  {
    id: 'gmail',
    name: 'Gmail',
    desc: 'Lecture et envoi d’e-mails.',
    apiBase: 'https://gmail.googleapis.com/gmail/v1',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Token d’accès OAuth2',
        placeholder: 'ya29.…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
          headers: bearer(v.token),
        },
        (j) => str(j, 'emailAddress'),
      ),
  },
  {
    id: 'drive',
    name: 'Google Drive',
    desc: 'Fichiers dans le cloud Google.',
    apiBase: 'https://www.googleapis.com/drive/v3',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Token d’accès OAuth2',
        placeholder: 'ya29.…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://www.googleapis.com/drive/v3/about?fields=user',
          headers: bearer(v.token),
        },
        (j) => str(j, 'user', 'emailAddress'),
      ),
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    desc: 'Fichiers dans le cloud Microsoft.',
    apiBase: 'https://graph.microsoft.com/v1.0',
    auth: (v) => ({ headers: bearer(v.token) }),
    fields: [
      {
        key: 'token',
        label: 'Token d’accès OAuth2',
        placeholder: 'Token Microsoft Graph…',
        type: 'password',
      },
    ],
    validate: (v) =>
      check(
        {
          url: 'https://graph.microsoft.com/v1.0/me',
          headers: bearer(v.token),
        },
        (j) => str(j, 'userPrincipalName') || str(j, 'displayName'),
      ),
  },
  {
    id: 'mega',
    name: 'MEGA',
    desc: 'Stockage chiffré. Identifiants stockés chiffrés (validation live non disponible pour MEGA).',
    apiBase: '',
    auth: () => {
      throw new Error('MEGA exposes no plain HTTP API.');
    },
    fields: [
      {
        key: 'email',
        label: 'E-mail',
        placeholder: 'vous@exemple.com',
        type: 'text',
      },
      {
        key: 'password',
        label: 'Mot de passe',
        placeholder: 'Mot de passe MEGA',
        type: 'password',
      },
    ],
    // MEGA's login requires a full cryptographic handshake (RSA/AES) that a
    // simple HTTP check cannot perform — credentials are stored encrypted
    // without live validation.
    validate: (v) => Promise.resolve(v.email.trim()),
  },
  {
    id: 'sftp',
    name: 'SFTP',
    desc: 'Serveur de fichiers distant. La connexion valide l’hôte et le port.',
    apiBase: '',
    auth: () => {
      throw new Error('SFTP is not an HTTP service.');
    },
    fields: [
      {
        key: 'host',
        label: 'Hôte',
        placeholder: 'sftp.exemple.com',
        type: 'text',
      },
      { key: 'port', label: 'Port', placeholder: '22', type: 'text' },
      {
        key: 'username',
        label: 'Utilisateur',
        placeholder: 'utilisateur',
        type: 'text',
      },
      {
        key: 'password',
        label: 'Mot de passe',
        placeholder: 'Mot de passe',
        type: 'password',
      },
    ],
    validate: (v) =>
      tcpReachable(v.host.trim(), Number(v.port.trim() || '22')).then(
        () => `${v.username.trim()}@${v.host.trim()}`,
      ),
  },
];

export interface ConnectorStatus {
  id: string;
  name: string;
  desc: string;
  fields: ConnectorField[];
  connected: boolean;
  login: string;
  manual: boolean;
}

export class ExternalAccounts {
  constructor(
    private readonly store: SecretConfigStore,
    private readonly secret: string,
    private readonly legacySecret = '',
  ) {}

  private read(id: string): {
    fieldsCipher?: string;
    login?: string;
    customName?: string;
  } {
    try {
      return JSON.parse(
        this.store.configGet(`${STORE_PREFIX}${id}`) ?? '{}',
      ) as { fieldsCipher?: string; login?: string; customName?: string };
    } catch {
      return {};
    }
  }

  private write(
    id: string,
    value: { fieldsCipher?: string; login?: string; customName?: string },
  ) {
    if (!value.fieldsCipher && !value.login)
      this.store.configDelete(`${STORE_PREFIX}${id}`);
    else this.store.configSet(`${STORE_PREFIX}${id}`, JSON.stringify(value));
  }

  defs(): ConnectorDef[] {
    return CONNECTOR_DEFS;
  }

  /** Manual (user-created) connectors. */
  manuals(): { id: string; name: string }[] {
    return this.store.configList(`${STORE_PREFIX}manual:`).map(({ key }) => {
      const id = key.slice(STORE_PREFIX.length);
      const stored = this.read(id);
      return { id, name: stored.customName || stored.login || id };
    });
  }

  /** Full status for the UI — credentials never leave the server. */
  list(): ConnectorStatus[] {
    const out: ConnectorStatus[] = CONNECTOR_DEFS.map((def) => {
      const stored = this.read(def.id);
      return {
        id: def.id,
        name: def.name,
        desc: def.desc,
        fields: def.fields,
        connected: !!stored.fieldsCipher && !!stored.login,
        login: stored.login ?? '',
        manual: false,
      };
    });
    for (const { id, name } of this.manuals()) {
      const stored = this.read(id);
      out.push({
        id,
        name,
        desc: 'Connecteur manuel.',
        fields: [
          {
            key: 'secret',
            label: 'Secret',
            placeholder: 'Valeur secrète…',
            type: 'password',
          },
        ],
        connected: !!stored.fieldsCipher,
        login: stored.login ?? '',
        manual: true,
      });
    }
    return out;
  }

  /** Decrypted credential fields for server-side use. */
  credentials(id: string): Record<string, string> | undefined {
    const stored = this.read(id);
    if (!stored.fieldsCipher) return undefined;
    try {
      const raw = decryptSecret(
        stored.fieldsCipher,
        this.secret,
        this.legacySecret,
      );
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return undefined;
    }
  }

  isConnected(id: string): boolean {
    const stored = this.read(id);
    return !!stored.fieldsCipher && !!stored.login;
  }

  def(id: string): ConnectorDef | undefined {
    return CONNECTOR_DEFS.find((d) => d.id === id);
  }

  /** Connectors that are both connected and callable over HTTP. */
  callableServices(): { id: string; name: string }[] {
    return CONNECTOR_DEFS.filter(
      (d) => d.apiBase && this.isConnected(d.id),
    ).map((d) => ({ id: d.id, name: d.name }));
  }

  async connect(id: string, values: Record<string, string>): Promise<string> {
    const def = CONNECTOR_DEFS.find((d) => d.id === id);
    if (!def) throw new Error('Connecteur inconnu.');
    const cleaned: Record<string, string> = {};
    for (const field of def.fields) {
      const value = (values[field.key] ?? '').trim();
      if (!value) throw new Error(`« ${field.label} » est requis.`);
      cleaned[field.key] = value;
    }
    let login: string;
    try {
      login = await def.validate(cleaned);
    } catch (cause) {
      if (cause instanceof Error) throw cause;
      throw new Error('Validation impossible.', { cause });
    }
    this.write(id, {
      fieldsCipher: encryptSecret(JSON.stringify(cleaned), this.secret),
      login,
    });
    return login;
  }

  connectManual(name: string, secret: string): string {
    const trimmedName = name.trim().slice(0, 40);
    const trimmedSecret = secret.trim();
    if (!trimmedName) throw new Error('Un nom est requis.');
    if (!trimmedSecret) throw new Error('Un secret est requis.');
    const id = `manual:${randomUUID()}`;
    this.write(id, {
      fieldsCipher: encryptSecret(
        JSON.stringify({ secret: trimmedSecret }),
        this.secret,
      ),
      login: trimmedName,
      customName: trimmedName,
    });
    return id;
  }

  disconnect(id: string) {
    this.write(id, {});
  }
}

export function externalAccountRoutes(accounts: ExternalAccounts) {
  const app = new Hono();
  app.get('/external-accounts', (c) => c.json({ connectors: accounts.list() }));
  app.put('/external-accounts/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = z
      .object({ values: z.record(z.string(), z.string()).default({}) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Requête invalide.' }, 400);
    try {
      const login = await accounts.connect(id, parsed.data.values);
      return c.json({ ok: true, login });
    } catch (cause) {
      return c.json(
        {
          error:
            cause instanceof Error ? cause.message : 'Connexion impossible.',
        },
        400,
      );
    }
  });
  app.post('/external-accounts/manual', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40),
        secret: z.string().trim().min(1).max(2000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Requête invalide.' }, 400);
    try {
      const id = accounts.connectManual(parsed.data.name, parsed.data.secret);
      return c.json({ ok: true, id });
    } catch (cause) {
      return c.json(
        {
          error:
            cause instanceof Error ? cause.message : 'Création impossible.',
        },
        400,
      );
    }
  });
  app.delete('/external-accounts/:id', (c) => {
    accounts.disconnect(c.req.param('id'));
    return c.json({ ok: true });
  });
  return app;
}
