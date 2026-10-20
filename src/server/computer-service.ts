import { createHash, createHmac, randomBytes } from 'node:crypto';
import { RE2 } from 're2';
import { z } from 'zod';
import { validateUrl } from './net-security.js';
import {
  computerInputs,
  computerPermissionsSchema,
  type ComputerActivityEvent,
  type ComputerAction,
  type ComputerControl,
  type ComputerPermissions,
  type ComputerStatus,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
import { mimeForFilename, saveBinaryAttachment } from './generate-file.js';
/** An HTTP error from a computer, carrying the status and parsed error payload. */
export class ComputerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'ComputerHttpError';
  }
}
/**
 * Our own deadline elapsed while waiting on a computer. Distinct from a caller
 * cancellation so `action` can tell "the upstream is wedged" apart from "the
 * request went away", and only reset on the former.
 */
export class ComputerTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ComputerTimeoutError';
  }
}
/**
 * Messages this service raises that are safe to return to the client verbatim.
 * `ComputerHttpError` is deliberately excluded: it embeds the upstream
 * response body, which must not cross the boundary.
 */
export function isUserFacingComputerError(message: string): boolean {
  return /^(Dot not found|Computer service|Computer permission|Computer browser permission|Agents are paused|Start this Dot|Invalid computer namespace|Computer identity mismatch|Computer endpoint is not bound|Computer response exceeded|Computer request was cancelled|Human controls are owner-only|There is no active control request|Unknown computer action|Lecture impossible|Fichier tronqué|Fichier modifié depuis|oldText introuvable|occurences dans|Regex non supportée|Clone bloqué|Neutralisation \.git\/config|Clone trop volumineux|Op git inconnue|commit exige|checkout exige|clone exige|Navigation blocked|The owner currently has control)/.test(
    message,
  );
}
/**
 * Browser mutations that carry no element ref, so they are safe to retry after
 * taking a fresh snapshot. Click/type carry a ref bound to a snapshot id and
 * must not be replayed blindly.
 */
const REFLESS_BROWSER_MUTATIONS = new Set(['navigate', 'key', 'scroll']);
/** Bornes du flux d'activité : le terminal live montre la commande et une
 * sortie bornée, jamais un dump de 64 Ko. */
const ACTIVITY_COMMAND_MAX = 1024;
const ACTIVITY_OUTPUT_MAX = 8000;
/** Événements de journal conservés par Dot (rejoués aux nouveaux abonnés). */
const ACTIVITY_HISTORY_MAX = 300;
/** Port loopback du serveur statique qui expose le workspace au navigateur
 * du conteneur (`file://` est refusé par OpenBot). */
const PREVIEW_PORT = 8099;
/** Taille max d'un fichier renvoyé au chat par `files_send` : la réponse
 * d'un `/exec` est plafonnée à 4 Mo, et le base64 gonfle de ~33 %. */
const SEND_FILE_MAX_BYTES = 2_500_000;
/** Quote POSIX sûr pour un chemin validé (aucun `..`, relatif). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function boundText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max)}…[tronqué]` : text;
}
/** Empreinte du contenu lu : atténuation TOCTOU pour files_edit (pas un
 * CAS atomique — le conteneur n'offre pas d'écriture conditionnelle ;
 * documenté comme tel). */
function contentSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Abonné au flux d'activité live d'un Dot. En mémoire, mono-processus. */
export type ComputerActivityListener = (event: ComputerActivityEvent) => void;
/**
 * How long to wait on a single action once its computer is running. Above the
 * computer's own `NAVIGATION_TIMEOUT_MS` (30s) so a slow page cannot trip it,
 * but well under the supervisor deadline so a wedged browser is recovered fast.
 */
const ACTION_DEADLINE_MS = 45_000;
/** Longest a single shell command may take. The sandbox accepts timeoutMs up
 * to 600 s, so the app deadline must cover it. Browser/files keep the short
 * wedge-recovery deadline above: a wedged browser must reset fast, and the
 * 50 ms permission-watcher still kills a revoked run mid-command. */
const EXEC_DEADLINE_MS = 600_000;
/** Stream tickets: short-lived, single-use, dot-bound. The browser cannot set
 * upgrade headers, so it fetches a ticket over the authenticated API and
 * presents it once in the WS query — the owner token never lands in a URL,
 * proxy log, or browser history. */
const STREAM_TICKET_TTL_MS = 30_000;
const STREAM_TICKET_CAP = 1000;
/** Bornes du search/offset côté serveur : le modèle ne doit pas vider le
 * workspace dans son contexte via des lectures en boucle. */
const SEARCH_MAX_FILES = 20;
const SEARCH_MAX_LINE_CHARS = 500;
/** Cap disque post-clone (octets). Contrôle postérieur au téléchargement :
 * un remplissage transitoire pendant le clone reste possible (résiduel). */
const CLONE_MAX_BYTES = 500 * 1024 * 1024;
/** Sortie live d'un exec (défilement façon terminal local) : la commande
 * tourne en arrière-plan dans le conteneur, le serveur rapatrie
 * stdout/stderr ~1×/s (base64, découpe UTF-8 sûre) et émet des `chunk`.
 * Repli bufférisé classique si l'arrière-plan n'est pas supporté. */
const LIVE_POLL_MS = 800;
const LIVE_CHUNK_MAX = 4000;
const LIVE_STREAM_MAX = 200_000;
const LIVE_TAIL_BYTES = 9000;
/** Découpe un tampon brut en texte UTF-8 + octets retenus : une séquence
 * multi-octets coupée en fin de tampon est relue au prochain tour plutôt
 * que d'émettre un caractère de remplacement. Exportée pour les tests. */
export function utf8Split(raw: Buffer): { text: string; held: number } {
  let held = 0;
  let i = raw.length - 1;
  let cont = 0;
  while (i >= 0 && raw[i] >= 0x80 && raw[i] < 0xc0) {
    cont++;
    i--;
  }
  if (i >= 0 && raw[i] >= 0x80) {
    const lead = raw[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (cont + 1 < need) held = cont + 1;
  } else if (i < 0 && cont > 0) {
    held = cont;
  }
  return { text: raw.subarray(0, raw.length - held).toString('utf8'), held };
}
function snapshotRequired(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { snapshotRequired?: unknown }).snapshotRequired === true
  );
}
function humanHasControl(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { humanHasControl?: unknown }).humanHasControl === true
  );
}
const stateSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
});
const controlSchema = z.object({
  holder: z.enum(['bot', 'human']),
  requested: z.boolean(),
  transitioning: z.boolean(),
  resumeSnapshotRequired: z.boolean(),
  request: z.object({ id: z.string(), status: z.string() }).optional(),
});
export class ComputerService {
  constructor(
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    private paused: () => boolean,
    private transport: typeof fetch = fetch,
    private deadlineMs = 70000,
    private shared?: {
      activityListeners: Map<string, Set<ComputerActivityListener>>;
      /** Derniers événements par Dot : un panneau ouvert après coup voit
       * quand même les commandes récentes (le journal n'est pas persisté). */
      activityHistory: Map<string, ComputerActivityEvent[]>;
      streamTickets: Map<
        string,
        { dotId: string; userId: string; expiresAt: number }
      >;
    },
  ) {
    this.shared ??= {
      activityListeners: new Map(),
      activityHistory: new Map(),
      streamTickets: new Map(),
    };
  }
  /** Vue portée par un utilisateur : même état partagé (tickets, listeners). */
  forUser(userId: string, paused: () => boolean): ComputerService {
    return new ComputerService(
      this.workspace.forUser(userId),
      this.config,
      paused,
      this.transport,
      this.deadlineMs,
      this.shared,
    );
  }
  private get activityListeners() {
    return this.shared!.activityListeners;
  }
  private get activityHistory() {
    return this.shared!.activityHistory;
  }
  private get streamTickets() {
    return this.shared!.streamTickets;
  }
  get configured() {
    return !!(
      this.config.computerSupervisorUrl?.trim() &&
      this.config.computerSupervisorToken?.trim() &&
      this.config.computerToken?.trim()
    );
  }
  private token(id: string) {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`opendots-computer:${id}`)
      .digest('hex');
  }
  private requireDot(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id))
      throw new Error('Dot not found.');
  }
  private allowed(
    id: string,
    kind: 'browser' | 'files' | 'shell' | undefined,
    actor: 'agent' | 'owner',
  ) {
    this.requireDot(id);
    if (!this.configured)
      throw new Error('Computer service is not configured.');
    const policy = this.workspace.computers.permissions(id);
    if (!policy.enabled || (kind && !policy[kind]))
      throw new Error('Computer permission is disabled.');
    if (actor === 'agent' && this.paused())
      throw new Error('Agents are paused.');
  }
  private async json(
    url: string,
    token: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    dotId?: string,
    deadlineMs = this.deadlineMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(dotId ? { 'x-openbot-bot-id': dotId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = JSON.parse(await response.text());
        } catch {
          payload = undefined;
        }
        let detail =
          payload &&
          typeof payload === 'object' &&
          typeof (payload as { error?: unknown }).error === 'string'
            ? `: ${(payload as { error: string }).error}`
            : '';
        // Never let an upstream error reflect an infrastructure secret.
        for (const secret of [
          token,
          this.config.computerToken?.trim(),
          this.config.computerSupervisorToken?.trim(),
        ])
          if (secret) detail = detail.split(secret).join('[redacted]');
        const suffix =
          response.status === 409
            ? ' Refresh with computer_snapshot before retrying, or wait for the owner to release control.'
            : '.';
        throw new ComputerHttpError(
          `Computer service returned HTTP ${response.status}${detail}${suffix}`,
          response.status,
          payload,
        );
      }
      if (!response.body)
        throw new Error('Computer service returned an empty response.');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('Computer response exceeded its size limit.');
        }
        chunks.push(value);
      }
      // Infrastructure secrets must never leave the gateway even if an upstream response reflects one.
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        token,
        this.config.computerToken?.trim(),
        this.config.computerSupervisorToken?.trim(),
      ])
        if (secret) text = text.split(secret).join('[redacted]');
      return JSON.parse(text);
    } catch (error) {
      // Our own deadline fired (not the caller's signal): the upstream is wedged.
      if (controller.signal.aborted)
        throw new ComputerTimeoutError('Computer request timed out.', {
          cause: error,
        });
      if (combined.aborted)
        throw new Error('Computer request was cancelled or timed out.', {
          cause: error,
        });
      if (error instanceof ComputerHttpError) throw error;
      if (
        error instanceof Error &&
        /^Computer (service returned|response exceeded)/.test(error.message)
      )
        throw error;
      throw new Error(
        'Computer service is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private supervisor(path: string, body?: unknown, signal?: AbortSignal) {
    return this.json(
      `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}${path}`,
      this.config.computerSupervisorToken!.trim(),
      body,
      signal,
    );
  }
  private endpoint(id: string, raw: unknown) {
    const state = stateSchema.parse(raw);
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new Error('Invalid computer namespace.');
    const expected = `${ns}-computer-${id}`;
    if (state.botId !== id || state.container !== expected)
      throw new Error('Computer identity mismatch.');
    const url = new URL(
      state.url ??
        (state.port
          ? `http://127.0.0.1:${state.port}`
          : `http://${expected}:4100`),
    );
    const network =
      url.hostname === expected.toLowerCase() && url.port === '4100';
    const local =
      url.hostname === '127.0.0.1' &&
      !!state.port &&
      url.port === String(state.port) &&
      new URL(this.config.computerSupervisorUrl!).hostname === '127.0.0.1';
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!network && !local)
    )
      throw new Error('Computer endpoint is not bound to this Dot.');
    return url.origin;
  }
  private async existing(id: string, signal?: AbortSignal) {
    const listing = z
      .object({ computers: z.array(stateSchema) })
      .parse(await this.supervisor('/computers', undefined, signal));
    return listing.computers.find((c) => c.botId === id);
  }
  private async running(id: string, signal?: AbortSignal) {
    const state = await this.existing(id, signal);
    if (!state || state.status !== 'running')
      throw new Error('Start this Dot’s computer first.');
    return this.endpoint(id, state);
  }
  /** Target + credential for the live WebSocket screen stream of a Dot. */
  async streamTarget(id: string): Promise<{ url: string; token: string }> {
    this.requireDot(id);
    if (!this.configured)
      throw new Error('Computer service is not configured.');
    const policy = this.workspace.computers.permissions(id);
    if (!policy.enabled || !policy.browser)
      throw new Error('Computer browser permission is disabled.');
    const origin = await this.running(id);
    return { url: origin.replace(/^http/, 'ws'), token: this.token(id) };
  }
  async status(id: string): Promise<ComputerStatus> {
    this.requireDot(id);
    const base = {
      configured: this.configured,
      permissions: this.workspace.computers.permissions(id),
      audit: this.workspace.computers.audit(id),
    };
    if (!this.configured) return { ...base, state: 'not_configured' };
    try {
      const state = await this.existing(id);
      if (!state || state.status !== 'running')
        return { ...base, state: 'stopped' };
      const url = this.endpoint(id, state);
      const control = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      return { ...base, state: 'running', control };
    } catch {
      return {
        ...base,
        state: 'unavailable',
        error:
          'Computer service is unavailable. Check the supervisor configuration and connection.',
      };
    }
  }
  /**
   * Mint a single-use stream ticket for a Dot's browser view. Tickets live
   * 30 s and are consumed atomically on upgrade, so a leaked URL dies
   * almost immediately and cannot be replayed.
   */
  mintStreamTicket(id: string): string {
    this.requireDot(id);
    const userId = this.workspace.userId;
    // Fail-closed : un ticket minté hors contexte utilisateur (instance
    // globale du pont WS) ne serait rattaché à personne — le pont le
    // refuserait de toute façon. Le mint n'a lieu que via la route
    // authentifiée (service porté par l'utilisateur).
    if (!userId) throw new Error('Dot not found.');
    const now = Date.now();
    for (const [ticket, entry] of this.streamTickets)
      if (entry.expiresAt <= now) this.streamTickets.delete(ticket);
    while (this.streamTickets.size >= STREAM_TICKET_CAP) {
      const oldest = this.streamTickets.keys().next();
      if (oldest.done) break;
      this.streamTickets.delete(oldest.value);
    }
    const ticket = randomBytes(32).toString('hex');
    this.streamTickets.set(ticket, {
      dotId: id,
      userId,
      expiresAt: now + STREAM_TICKET_TTL_MS,
    });
    return ticket;
  }
  /** Consume a ticket once; returns the bound dot + owner, or null when unknown, expired, or replayed. */
  consumeStreamTicket(
    ticket: string,
  ): { dotId: string; userId: string } | null {
    const entry = this.streamTickets.get(ticket);
    if (!entry) return null;
    this.streamTickets.delete(ticket);
    if (entry.expiresAt <= Date.now()) return null;
    return { dotId: entry.dotId, userId: entry.userId };
  }
  /** S'abonner aux événements live d'un Dot. En mémoire, mono-processus :
   * le déploiement n'exécute qu'un seul serveur, donc aucun bus externe.
   * Les derniers événements sont rejoués à l'abonné : un panneau ouvert
   * après coup (ou une reconnexion) voit les commandes récentes. */
  subscribeActivity(
    dotId: string,
    listener: ComputerActivityListener,
  ): () => void {
    let set = this.activityListeners.get(dotId);
    if (!set) {
      set = new Set();
      this.activityListeners.set(dotId, set);
    }
    set.add(listener);
    for (const event of this.activityHistory.get(dotId) ?? []) {
      try {
        listener(event);
      } catch {
        // Un abonné ne casse jamais l'action en cours.
      }
    }
    return () => {
      set.delete(listener);
      if (set.size === 0) this.activityListeners.delete(dotId);
    };
  }
  private emitActivity(event: ComputerActivityEvent): void {
    const history = this.activityHistory.get(event.dotId) ?? [];
    const next = [...history, event];
    this.activityHistory.set(
      event.dotId,
      next.length > ACTIVITY_HISTORY_MAX
        ? next.slice(-ACTIVITY_HISTORY_MAX)
        : next,
    );
    const set = this.activityListeners.get(event.dotId);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Un abonné ne casse jamais l'action en cours.
      }
    }
  }
  /** Journal live du terminal : `start` dès le lancement, `end` au retour.
   * Périmètre `exec` uniquement (ni screenshots ni snapshots). En mode live,
   * des `chunk` incrementaux s'intercalent (voir `execLive`). */
  private beginActivity(
    id: string,
    actor: 'owner' | 'agent',
    parsed: unknown,
  ): {
    end(result: unknown): void;
    fail(error: unknown): void;
    progress(stdoutDelta: string, stderrDelta: string): void;
  } {
    const command = boundText(
      (parsed as { command?: unknown } | null)?.command,
      ACTIVITY_COMMAND_MAX,
    );
    const base = { dotId: id, action: 'exec' as const, actor, command };
    this.emitActivity({ ...base, phase: 'start', at: Date.now() });
    return {
      end: (result: unknown) => {
        const shell =
          result && typeof result === 'object'
            ? (result as Record<string, unknown>)
            : {};
        const asNumber = (value: unknown): number | undefined =>
          typeof value === 'number' && Number.isFinite(value)
            ? value
            : undefined;
        const asBool = (value: unknown): boolean | undefined =>
          typeof value === 'boolean' ? value : undefined;
        this.emitActivity({
          ...base,
          phase: 'end',
          at: Date.now(),
          exitCode: asNumber(shell.exitCode),
          stdout: boundText(shell.stdout, ACTIVITY_OUTPUT_MAX),
          stderr: boundText(shell.stderr, ACTIVITY_OUTPUT_MAX),
          truncated: asBool(shell.truncated),
          timedOut: asBool(shell.timedOut),
          elapsedMs: asNumber(shell.elapsedMs),
        });
      },
      fail: (error: unknown) => {
        this.emitActivity({
          ...base,
          phase: 'end',
          at: Date.now(),
          error: error instanceof Error ? error.message : 'Échec.',
        });
      },
      progress: (stdoutDelta: string, stderrDelta: string) => {
        if (!stdoutDelta && !stderrDelta) return;
        this.emitActivity({
          ...base,
          phase: 'chunk',
          at: Date.now(),
          chunk: boundText(stdoutDelta, LIVE_CHUNK_MAX),
          chunkStderr: boundText(stderrDelta, LIVE_CHUNK_MAX),
        });
      },
    };
  }
  /** Permissions du Dot (pour filtrer les outils exposés au modèle). */
  policy(id: string): ComputerPermissions {
    this.requireDot(id);
    return this.workspace.computers.permissions(id);
  }
  private async audited<T>(
    id: string,
    action: string,
    actor: 'owner' | 'agent',
    fn: () => Promise<T>,
  ): Promise<T> {
    this.requireDot(id);
    const receipt = this.workspace.computers.begin(id, action, actor);
    try {
      const result = await fn();
      this.workspace.computers.finish(receipt, 'succeeded');
      return result;
    } catch (error) {
      this.workspace.computers.finish(receipt, 'failed');
      throw error;
    }
  }
  async permissions(id: string, input: unknown) {
    const patch = computerPermissionsSchema.partial().parse(input);
    await this.audited(id, 'permissions', 'owner', async () =>
      this.workspace.computers.patch(id, patch),
    );
    return this.status(id);
  }
  async start(id: string) {
    await this.audited(id, 'start', 'owner', async () => {
      this.allowed(id, undefined, 'owner');
      this.endpoint(id, await this.supervisor(`/computers/${id}/ensure`, {}));
    });
    return this.status(id);
  }
  async stop(id: string) {
    await this.audited(id, 'stop', 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      await this.supervisor(`/computers/${id}/stop`, {});
    });
    return this.status(id);
  }
  async control(id: string, verb: 'take' | 'release') {
    await this.audited(id, verb, 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      const url = await this.running(id);
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      let control: ComputerControl = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      if (verb === 'take' && !control.request)
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (
        verb === 'take' &&
        control.request &&
        !['waiting', 'taken'].includes(control.request.status)
      )
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (!control.request)
        throw new Error('There is no active control request.');
      await this.json(
        `${url}/control/${verb}`,
        this.token(id),
        { requestId: control.request.id },
        undefined,
        id,
      );
    });
    return this.status(id);
  }
  /**
   * Stop and re-ensure a Dot's computer. Used to recover from a wedged browser
   * (see `action`): the container is recreated with the same volumes and the
   * published port changes, so callers must re-resolve the endpoint.
   */
  private async reset(id: string, signal?: AbortSignal) {
    await this.supervisor(`/computers/${id}/stop`, {}, signal);
    this.endpoint(
      id,
      await this.supervisor(`/computers/${id}/ensure`, {}, signal),
    );
  }
  /** Découpe une lecture fichier en plage de lignes (offset 1-based).
   * Le conteneur ne connaît que {path} : la plage est appliquée ici, après
   * un read entier, et offset/limit ne lui sont jamais transmis. */
  private async readFileSlice(
    url: string,
    id: string,
    input: { path: string; offset?: number; limit?: number },
    signal: AbortSignal,
  ): Promise<unknown> {
    const read = (await this.json(
      `${url}/files/read`,
      this.token(id),
      { path: input.path },
      signal,
      id,
    )) as { path?: unknown; text?: unknown; truncated?: unknown };
    const text = typeof read.text === 'string' ? read.text : '';
    const lines = text.split('\n');
    const from = Math.max(1, input.offset ?? 1);
    const to =
      input.limit === undefined
        ? lines.length
        : Math.min(lines.length, from - 1 + input.limit);
    return {
      path: input.path,
      text: lines.slice(Math.max(0, from - 1), Math.max(0, to)).join('\n'),
      from,
      to,
      totalLines: lines.length,
      truncated: read.truncated === true || to < lines.length,
      sha: contentSha(text),
    };
  }
  /** Recherche dans le workspace, composée de /files/list (récursif côté
   * conteneur) + /files/read. Fichiers illisibles comptés dans `skipped`,
   * pas d'échec global. Moteur RE2 (temps linéaire) : aucune syntaxe non
   * supportée ne retombe silencieusement sur RegExp — elle lève une erreur
   * claire. Entrées et sorties bornées. */
  private async searchFiles(
    url: string,
    id: string,
    input: { query: string; path?: string; maxResults?: number },
    signal: AbortSignal,
  ): Promise<unknown> {
    const scope = input.path ?? '';
    let pattern: { test(text: string): boolean };
    try {
      pattern = new RE2(input.query, 'm');
    } catch (error) {
      throw new Error(
        `Regex non supportée (moteur linéaire RE2) : ${error instanceof Error ? error.message.split('\n')[0] : 'syntaxe refusée'}.`,
        { cause: error },
      );
    }
    const maxResults = input.maxResults ?? 30;
    const list = (await this.json(
      `${url}/files/list`,
      this.token(id),
      { path: scope },
      signal,
      id,
    )) as {
      entries?: Array<{ path?: unknown; kind?: unknown }>;
      truncated?: unknown;
    };
    const files = (list.entries ?? []).filter((e) => e.kind === 'file');
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = list.truncated === true;
    // Fichiers illisibles : comptés dans `skipped`, visibles par l'agent
    // dans le résultat (pas seulement logués serveur).
    let skipped = 0;
    for (const file of files.slice(0, SEARCH_MAX_FILES)) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      if (typeof file.path !== 'string' || !file.path) continue;
      let read: { text?: unknown };
      try {
        read = (await this.json(
          `${url}/files/read`,
          this.token(id),
          { path: file.path },
          signal,
          id,
        )) as { text?: unknown };
      } catch {
        skipped += 1;
        continue;
      }
      if (typeof read.text !== 'string') {
        skipped += 1;
        continue;
      }
      const lines = read.text.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (pattern.test(lines[i]))
          matches.push({
            path: file.path,
            line: i + 1,
            text: lines[i].slice(0, SEARCH_MAX_LINE_CHARS),
          });
      }
    }
    if (files.length > SEARCH_MAX_FILES) truncated = true;
    return { path: scope, query: input.query, matches, truncated, skipped };
  }
  /** Édition chirurgicale : read → remplacements (match unique sauf
   * replaceAll) → write. Refuse si le read est tronqué (on n'édite pas un
   * fichier qu'on n'a pas lu en entier) ou si oldText est absent/ambigu.
   * Avec expectedSha : refuse si le fichier a changé depuis le read
   * (atténuation TOCTOU, pas un CAS atomique — documenté). */
  private async editFile(
    url: string,
    id: string,
    input: {
      path: string;
      edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>;
      expectedSha?: string;
    },
    signal: AbortSignal,
  ): Promise<unknown> {
    const read = (await this.json(
      `${url}/files/read`,
      this.token(id),
      { path: input.path },
      signal,
      id,
    )) as { path?: unknown; text?: unknown; truncated?: unknown };
    if (typeof read.text !== 'string')
      throw new Error('Lecture impossible avant édition.');
    if (read.truncated === true)
      throw new Error(
        'Fichier tronqué au read : édition refusée, lisez par plages.',
      );
    if (
      input.expectedSha !== undefined &&
      contentSha(read.text) !== input.expectedSha
    )
      throw new Error(
        `Fichier modifié depuis votre lecture (${input.path}) : relisez-le avant d'éditer.`,
      );
    let text = read.text;
    let applied = 0;
    for (const edit of input.edits) {
      const occurrences = text.split(edit.oldText).length - 1;
      if (occurrences === 0)
        throw new Error(
          `oldText introuvable dans ${input.path} : édition annulée, rien n'a été écrit.`,
        );
      if (occurrences > 1 && !edit.replaceAll)
        throw new Error(
          `${occurrences} occurrences dans ${input.path} : édition annulée, précisez replaceAll ou un oldText unique.`,
        );
      text =
        edit.replaceAll === true
          ? text.split(edit.oldText).join(edit.newText)
          : text.replace(edit.oldText, edit.newText);
      applied += edit.replaceAll === true ? occurrences : 1;
    }
    const written = (await this.json(
      `${url}/files/write`,
      this.token(id),
      { path: input.path, contents: text },
      signal,
      id,
    )) as { bytes?: unknown };
    return {
      path: input.path,
      applied,
      bytes: typeof written.bytes === 'number' ? written.bytes : null,
    };
  }
  /** Git sandboxé : construit une commande canonique `git -C …` à partir
   * d'args validés (jamais de shell libre), puis l'exécute via /exec.
   * push/pull/fetch exclus : pas de credentials dans le sandbox.
   * Clone : hôte validé (SSRF), `--depth 1 --single-branch` systématique,
   * neutralisation `.git/config` (hooks/pager/fsmonitor), et cap disque
   * 500 Mo post-clone (le remplissage transitoire pendant le clone reste
   * un résiduel documenté). */
  private async runGit(
    id: string,
    input: {
      op: string;
      path?: string;
      message?: string;
      ref?: string;
      url?: string;
    },
    actor: 'owner' | 'agent',
    signal: AbortSignal,
  ): Promise<unknown> {
    const dir = input.path && input.path.length > 0 ? input.path : '.';
    // Guillemet simple shell : seul échappement nécessaire (ref/url déjà
    // restreints par le schéma à des caractères sûrs).
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    let command: string;
    switch (input.op) {
      case 'status':
        command = `git -C ${q(dir)} status --porcelain=v1 -b`;
        break;
      case 'diff':
        command = `git -C ${q(dir)} diff --no-color`;
        break;
      case 'log':
        command = `git -C ${q(dir)} log --oneline -n 20`;
        break;
      case 'add':
        command = `git -C ${q(dir)} add -A`;
        break;
      case 'branches':
        command = `git -C ${q(dir)} branch -a`;
        break;
      case 'commit':
        if (!input.message) throw new Error('commit exige message.');
        command = `git -C ${q(dir)} add -A && git -C ${q(dir)} commit -m ${q(input.message)}`;
        break;
      case 'checkout':
        if (!input.ref) throw new Error('checkout exige ref.');
        command = `git -C ${q(dir)} checkout ${q(input.ref)}`;
        break;
      case 'init':
        command = `git init ${q(dir)}`;
        break;
      case 'clone': {
        if (!input.url) throw new Error('clone exige url.');
        // SSRF : le risque est l'hôte (ports custom légitimes pour les
        // forges self-hosted) — même motif que validateMcpUrl.
        try {
          await validateUrl(input.url, { ports: 'any' });
        } catch (error) {
          throw new Error(
            `Clone bloqué (${input.url}) : ${error instanceof Error ? error.message : 'hôte non public'}.`,
            { cause: error },
          );
        }
        const target =
          input.path && input.path.length > 0 ? input.path : 'repo';
        // Shallow systématique : borne le disque téléchargé. Tradeoff
        // documenté dans la description de l'outil (log tronqué).
        // Watcher pendant le transfert : `setsid` fait du clone le chef de
        // session/process-group ; on sonde la taille et on tue le groupe s'il
        // dépasse le cap, AVANT que le disque ne se remplisse (résiduel clos).
        command =
          `setsid git clone --depth 1 --single-branch ${q(input.url)} ${q(target)} & pid=$!\n` +
          `while kill -0 "$pid" 2>/dev/null; do\n` +
          `sz=$(du -sb ${q(target)} 2>/dev/null | cut -f1); [ -z "$sz" ] && sz=0\n` +
          `if [ "$sz" -gt ${CLONE_MAX_BYTES} ]; then kill -9 -- -"$pid" 2>/dev/null; rm -rf ${q(target)}; echo clone-size-exceeded 1>&2; exit 124; fi\n` +
          `sleep 1\ndone\nwait "$pid"; exit $?`;
        const cloned = (await this.action(
          id,
          'exec',
          { command, timeoutMs: 300000 },
          actor,
          signal,
        )) as { exitCode?: unknown; stderr?: unknown };
        if (
          typeof cloned !== 'object' ||
          cloned === null ||
          cloned.exitCode !== 0
        )
          return cloned;
        // Neutralise ce que le distant pourrait activer via .git/config :
        // hooks exécutables, pager arbitraire, fsmonitor. `|| true` : unset
        // échoue (code 5) quand la clé est absente, ce n'est pas une erreur.
        // Échec réel (exit non-zéro) = clone refusé + cible supprimée : jamais
        // de clone retourné comme succès avec une config non neutralisée.
        const neutralize =
          `git -C ${q(target)} config --local core.pager cat && ` +
          `(git -C ${q(target)} config --local unset-all core.hooksPath || true) && ` +
          `(git -C ${q(target)} config --local unset-all core.fsmonitor || true) && ` +
          `git -C ${q(target)} config --local core.fsmonitor false`;
        const neutralized = (await this.action(
          id,
          'exec',
          { command: neutralize, timeoutMs: 60000 },
          actor,
          signal,
        )) as { exitCode?: unknown; stderr?: unknown };
        if (
          typeof neutralized !== 'object' ||
          neutralized === null ||
          neutralized.exitCode !== 0
        ) {
          await this.action(
            id,
            'exec',
            { command: `rm -rf ${q(target)}`, timeoutMs: 60000 },
            actor,
            signal,
          );
          throw new Error(
            `Neutralisation .git/config impossible (${target}) : clone supprimé.`,
          );
        }
        // Borne disque post-clone (résiduel transitoire documenté).
        const sized = (await this.action(
          id,
          'exec',
          { command: `du -sb ${q(target)}`, timeoutMs: 60000 },
          actor,
          signal,
        )) as { stdout?: unknown };
        const bytes = Number.parseInt(
          String(sized?.stdout ?? '').split(/\s/)[0] ?? '',
          10,
        );
        if (Number.isFinite(bytes) && bytes > CLONE_MAX_BYTES) {
          await this.action(
            id,
            'exec',
            { command: `rm -rf ${q(target)}`, timeoutMs: 60000 },
            actor,
            signal,
          );
          throw new Error(
            `Clone trop volumineux (${bytes} octets, cap ${CLONE_MAX_BYTES}) : supprimé.`,
          );
        }
        return cloned;
      }
      default:
        throw new Error(`Op git inconnue : ${input.op}.`);
    }
    // Via exec : permission shell re-vérifiée, activité émise dans le
    // journal terminal, timeout 5 min (clones volumineux).
    return this.action(
      id,
      'exec',
      { command, timeoutMs: 300000 },
      actor,
      signal,
    );
  }
  /** Exec classique (bufférisé) : un seul appel, sortie complète au retour.
   * Chemin de repli quand personne n'écoute le journal ou que l'arrière-plan
   * n'est pas supporté par le conteneur. */
  private async execBuffered(
    id: string,
    url: string,
    parsed: { command: string; timeoutMs?: number },
    activeSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await this.json(
      `${url}/exec`,
      this.token(id),
      parsed,
      activeSignal,
      id,
      EXEC_DEADLINE_MS,
    );
    if (result && typeof result === 'object') {
      const copy = { ...(result as Record<string, unknown>) };
      delete copy.command;
      // Borne UNIQUE des sorties exec (même constante que le journal
      // d'activité) : UI, modèle et API reçoivent pareil.
      for (const key of ['stdout', 'stderr'] as const) {
        if (
          typeof copy[key] === 'string' &&
          (copy[key] as string).length > ACTIVITY_OUTPUT_MAX
        ) {
          copy[key] =
            `${(copy[key] as string).slice(0, ACTIVITY_OUTPUT_MAX)}…[tronqué]`;
          copy.truncated = true;
        }
      }
      return copy;
    }
    return {};
  }
  /** Lecture finale d'un run live : totaux + queue des journaux (base64).
   * Utilisée à la fin normale comme au dépassement de délai. */
  private async readLiveEnd(
    id: string,
    url: string,
    token: string,
    files: { out: string; err: string; code: string },
    activeSignal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const res = (await this.json(
      `${url}/exec`,
      token,
      {
        command: [
          `wc -c < ${files.out} 2>/dev/null || echo 0`,
          `wc -c < ${files.err} 2>/dev/null || echo 0`,
          `tail -c ${LIVE_TAIL_BYTES} ${files.out} 2>/dev/null | base64 | tr -d '\\n'; echo`,
          `tail -c ${LIVE_TAIL_BYTES} ${files.err} 2>/dev/null | base64 | tr -d '\\n'; echo`,
        ].join('\n'),
        timeoutMs: 15000,
      },
      activeSignal,
      id,
      Math.min(ACTION_DEADLINE_MS, this.deadlineMs),
    )) as { stdout?: unknown };
    const lines = String(res?.stdout ?? '').split('\n');
    const totalOut = Number(lines[0]);
    const totalErr = Number(lines[1]);
    const tailOut = Buffer.from(lines[2] ?? '', 'base64')
      .toString('utf8')
      .replace(/^\uFFFD/, '');
    const tailErr = Buffer.from(lines[3] ?? '', 'base64')
      .toString('utf8')
      .replace(/^\uFFFD/, '');
    const truncated =
      (Number.isFinite(totalOut) && totalOut > ACTIVITY_OUTPUT_MAX) ||
      (Number.isFinite(totalErr) && totalErr > ACTIVITY_OUTPUT_MAX);
    return {
      stdout: truncated ? boundText(tailOut, ACTIVITY_OUTPUT_MAX) : tailOut,
      stderr: truncated ? boundText(tailErr, ACTIVITY_OUTPUT_MAX) : tailErr,
      truncated,
    };
  }
  /**
   * Exec live (défilement façon terminal local) : la commande tourne en
   * arrière-plan dans le conteneur (`{ cmd } > out 2> err; echo $? > code
   * &`), le serveur rapatrie stdout/stderr ~1×/s et émet des `chunk` vers
   * le journal. Le résultat final porte la QUEUE des sorties (plus utile
   * qu'un début tronqué pour les builds longs). Repli bufférisé classique
   * sur toute anomalie (conteneur sans arrière-plan, lancement illisible).
   * L'annulation (révocation, stop UI) tue le processus distant.
   */
  private async execLive(
    id: string,
    url: string,
    parsed: { command: string; timeoutMs?: number },
    activeSignal: AbortSignal,
    watch: { progress(out: string, err: string): void },
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(
      Math.max(parsed.timeoutMs ?? 30000, 1000),
      EXEC_DEADLINE_MS,
    );
    const token = this.token(id);
    const rpc = (command: string) =>
      this.json(
        `${url}/exec`,
        token,
        { command, timeoutMs: 15000 },
        activeSignal,
        id,
        Math.min(ACTION_DEADLINE_MS, this.deadlineMs),
      ) as Promise<{ stdout?: unknown }>;
    const fallback = () => this.execBuffered(id, url, parsed, activeSignal);
    // Le `&`/`;` final fausserait la détection de fin (groupe terminé
    // aussitôt) : on l'exécute au premier plan dans le groupe.
    const raw = (parsed.command ?? '').replace(/[;\s&]+$/, '');
    if (!raw) return fallback();
    const tag = randomBytes(6).toString('hex');
    const files = {
      out: `.live-${tag}.out`,
      err: `.live-${tag}.err`,
      code: `.live-${tag}.code`,
    };
    const killRemote = (pid: number) =>
      rpc(
        `kill -9 ${pid} 2>/dev/null; rm -f ${files.out} ${files.err} ${files.code}`,
      ).catch(() => {});
    let pid = NaN;
    try {
      const launched = await rpc(
        `find . -maxdepth 1 -name '.live-*' -mmin +60 -delete 2>/dev/null; { ${raw}\n} > ${files.out} 2> ${files.err}; echo $? > ${files.code} & echo LIVE_PID_${tag}:$!`,
      );
      const m = new RegExp(`LIVE_PID_${tag}:(\\d+)`).exec(
        String(launched?.stdout ?? ''),
      );
      if (m) pid = Number(m[1]);
    } catch (error) {
      if (activeSignal.aborted) throw error;
      return fallback();
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) return fallback();
    let offOut = 1;
    let offErr = 1;
    let streamed = 0;
    let cappedNote = false;
    // Un processus tué sans écrire son code (OOM, kill externe) ne doit pas
    // faire tourner la boucle jusqu'au timeout : on lui laisse une grâce.
    let goneWithoutCode = 0;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    for (;;) {
      try {
        activeSignal.throwIfAborted();
      } catch (error) {
        // Annulation (révocation, stop UI) : le processus distant ne doit
        // pas survivre au run.
        await killRemote(pid);
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        await killRemote(pid);
        const end = await this.readLiveEnd(
          id,
          url,
          token,
          files,
          activeSignal,
        ).catch(() => ({ stdout: '', stderr: '', truncated: true }));
        return {
          ...end,
          timedOut: true,
          elapsedMs: Date.now() - startedAt,
        };
      }
      let poll: { stdout?: unknown };
      try {
        poll = await rpc(
          [
            `tail -c +${offOut} ${files.out} 2>/dev/null | base64 | tr -d '\\n'; echo`,
            `tail -c +${offErr} ${files.err} 2>/dev/null | base64 | tr -d '\\n'; echo`,
            `if kill -0 ${pid} 2>/dev/null; then echo LIVE_${tag}_S:ALIVE; else echo LIVE_${tag}_S:GONE; fi`,
            `if test -f ${files.code}; then echo LIVE_${tag}_C:$(cat ${files.code}); else echo LIVE_${tag}_C:NO; fi`,
            `if test -f ${files.code}; then`,
            `wc -c < ${files.out} 2>/dev/null || echo 0`,
            `wc -c < ${files.err} 2>/dev/null || echo 0`,
            `tail -c ${LIVE_TAIL_BYTES} ${files.out} 2>/dev/null | base64 | tr -d '\\n'; echo`,
            `tail -c ${LIVE_TAIL_BYTES} ${files.err} 2>/dev/null | base64 | tr -d '\\n'; echo`,
            `rm -f ${files.out} ${files.err} ${files.code}`,
            `fi`,
          ].join('\n'),
        );
      } catch (error) {
        // Poll perdu (réseau) : on réessaie au tour suivant, sauf
        // annulation (le processus distant est alors tué).
        if (activeSignal.aborted) {
          await killRemote(pid);
          throw error;
        }
        await sleep(LIVE_POLL_MS);
        continue;
      }
      // Disposition fixe du script : 2 lignes base64 (sans ':' possible),
      // puis marqueurs, puis bloc final (totaux + queues + nettoyage).
      const lines = String(poll?.stdout ?? '').split('\n');
      const sLine = lines.find((l) => l.startsWith(`LIVE_${tag}_S:`));
      const cLine = lines.find((l) => l.startsWith(`LIVE_${tag}_C:`));
      if (sLine === undefined || cLine === undefined) {
        await sleep(LIVE_POLL_MS);
        continue;
      }
      const alive = sLine.endsWith(':ALIVE');
      const codeV = cLine.slice(`LIVE_${tag}_C:`.length);
      const codeStr = codeV === 'NO' ? undefined : codeV;
      const outB64 = lines[0] ?? '';
      const errB64 = lines[1] ?? '';
      // Bloc final : présent seulement quand le run est terminé — disposé
      // juste après le marqueur C (2 totaux puis 2 queues).
      const cIdx = lines.indexOf(cLine);
      const after = lines.slice(cIdx + 1);
      const doneBlock =
        after.length >= 4 && /^\d+$/.test(after[0]) && /^\d+$/.test(after[1]);
      const totalOut = doneBlock ? Number(after[0]) : NaN;
      const totalErr = doneBlock ? Number(after[1]) : NaN;
      const endOutB64 = doneBlock ? after[2] : undefined;
      const endErrB64 = doneBlock ? after[3] : undefined;
      const outRaw = Buffer.from(outB64, 'base64');
      const errRaw = Buffer.from(errB64, 'base64');
      const { text: outText, held: outHeld } = utf8Split(outRaw);
      const { text: errText, held: errHeld } = utf8Split(errRaw);
      offOut += outRaw.length - outHeld;
      offErr += errRaw.length - errHeld;
      if ((outText || errText) && streamed < LIVE_STREAM_MAX) {
        watch.progress(outText, errText);
        streamed += outText.length + errText.length;
        if (streamed >= LIVE_STREAM_MAX && !cappedNote) {
          cappedNote = true;
          watch.progress(
            '…[sortie trop volumineuse : fin du défilement, résultat en fin d’exécution]\n',
            '',
          );
        }
      }
      const exitCode = codeStr !== undefined ? Number(codeStr) : NaN;
      // La fin se lit dans le fichier de code, PAS via `kill -0` : le
      // processus réparenté devient un zombie (PID 1 ne le reap pas) et
      // `kill -0` réussit indéfiniment — le run ne finissait jamais.
      if (codeStr !== undefined && Number.isSafeInteger(exitCode)) {
        // Fin normale : queue déjà rapatriée par ce même poll (nettoyage
        // fait côté conteneur).
        const tailOut = (
          endOutB64 !== undefined
            ? Buffer.from(endOutB64, 'base64').toString('utf8')
            : outText
        ).replace(/^\uFFFD/, '');
        const tailErr = (
          endErrB64 !== undefined
            ? Buffer.from(endErrB64, 'base64').toString('utf8')
            : errText
        ).replace(/^\uFFFD/, '');
        const truncated =
          (Number.isFinite(totalOut) && totalOut > ACTIVITY_OUTPUT_MAX) ||
          (Number.isFinite(totalErr) && totalErr > ACTIVITY_OUTPUT_MAX) ||
          endOutB64 === undefined;
        return {
          stdout: truncated ? boundText(tailOut, ACTIVITY_OUTPUT_MAX) : tailOut,
          stderr: truncated ? boundText(tailErr, ACTIVITY_OUTPUT_MAX) : tailErr,
          exitCode,
          truncated,
          elapsedMs: Date.now() - startedAt,
        };
      }
      // Processus disparu (OOM, kill externe) sans écrire son code : on
      // rend la sortie partielle après une grâce de ~8 s plutôt que
      // d'attendre le timeout complet.
      if (!alive) {
        goneWithoutCode++;
        if (goneWithoutCode >= 10)
          return {
            stdout: boundText(outText, ACTIVITY_OUTPUT_MAX),
            stderr: `${errText}\n[processus terminé sans code de sortie]`.slice(
              -ACTIVITY_OUTPUT_MAX,
            ),
            truncated: true,
            elapsedMs: Date.now() - startedAt,
          };
      } else goneWithoutCode = 0;
      await sleep(LIVE_POLL_MS);
    }
  }
  /** Ouvre un fichier du workspace dans le navigateur du Dot. OpenBot
   * refuse `file://` ; on sert donc `/workspace` sur 127.0.0.1 (interne au
   * conteneur) et on navigue dessus. Le serveur statique est relancé au
   * besoin (idempotent, port loopback uniquement). */
  private async previewFile(
    id: string,
    url: string,
    input: { path: string },
    activeSignal: AbortSignal,
  ): Promise<{ path: string; url: string }> {
    const token = this.token(id);
    const probe = `python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.3); sys.exit(0 if s.connect_ex(("127.0.0.1",${PREVIEW_PORT}))==0 else 1)'`;
    // `setsid` détache le serveur du groupe de processus de l'exec : sinon
    // /exec attend la fin du serveur (pipe/process group) et expire.
    await this.json(
      `${url}/exec`,
      token,
      {
        command: [
          `${probe} || { setsid sh -c 'cd /workspace && exec python3 -m http.server ${PREVIEW_PORT} --bind 127.0.0.1' </dev/null >/dev/null 2>&1 & }`,
          `for i in 1 2 3 4 5 6 7 8 9 10; do ${probe} && break; sleep 0.2; done`,
          'echo ok',
        ].join('\n'),
        timeoutMs: 15000,
      },
      activeSignal,
      id,
      Math.min(ACTION_DEADLINE_MS, this.deadlineMs),
    );
    const encoded = input.path.split('/').map(encodeURIComponent).join('/');
    const target = `http://127.0.0.1:${PREVIEW_PORT}/${encoded}`;
    await this.json(
      `${url}/navigate`,
      token,
      { url: target },
      activeSignal,
      id,
      Math.min(ACTION_DEADLINE_MS, this.deadlineMs),
    );
    return { path: input.path, url: target };
  }
  /** Envoie un fichier existant du workspace au chat : lecture brute
   * (base64 via exec) puis pièce jointe, sans passer par le modèle. Le
   * contenu n'est jamais réémis en tokens ; les octets sont préservés. */
  private async sendFile(
    id: string,
    url: string,
    input: { path: string },
    activeSignal: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    size: number;
    downloadUrl: string;
  }> {
    const result = (await this.json(
      `${url}/exec`,
      this.token(id),
      {
        command: `base64 -w0 -- ${shellQuote(input.path)}`,
        timeoutMs: 30000,
      },
      activeSignal,
      id,
      Math.min(ACTION_DEADLINE_MS, this.deadlineMs),
    )) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    if (typeof result.exitCode === 'number' && result.exitCode !== 0)
      throw new Error(
        `Fichier introuvable ou illisible : ${input.path}${typeof result.stderr === 'string' && result.stderr.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : ''}.`,
      );
    const encoded =
      typeof result.stdout === 'string'
        ? result.stdout.replace(/\s+/g, '')
        : '';
    if (!encoded) throw new Error(`Fichier vide : ${input.path}.`);
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length) throw new Error(`Fichier vide : ${input.path}.`);
    if (buffer.length > SEND_FILE_MAX_BYTES)
      throw new Error(
        `Fichier trop volumineux pour l'envoi direct (${(buffer.length / 1024 / 1024).toFixed(1)} Mo, max ${SEND_FILE_MAX_BYTES / 1_000_000} Mo) : compressez-le (zip) puis renvoyez l'archive.`,
      );
    const name = input.path.split('/').pop() || 'fichier';
    const saved = await saveBinaryAttachment(
      name,
      buffer,
      mimeForFilename(name),
    );
    return {
      id: saved.id,
      name: saved.name,
      size: saved.size,
      downloadUrl: `/api/attachments/${saved.id}/content?download=1`,
    };
  }
  /**
   * Installe (ou rafraîchit) le bundle d'un skill dans le workspace du Dot.
   * Le serveur sert un tar gzip à usage unique ; le conteneur le télécharge
   * en local et l'extrait dans `.skills/<repo>/<name>`. Idempotent : le
   * marqueur `.opendots-version` évite une recopie inutile.
   */
  async installSkillBundle(
    id: string,
    input: {
      ticket: string;
      path: string;
      version: string;
      baseUrl: string;
    },
    signal?: AbortSignal,
  ): Promise<{ installed: boolean; current: boolean; path: string }> {
    this.allowed(id, 'files', 'agent');
    const base = await this.running(id, signal);
    const target = input.path.replace(/\/+$/, '');
    if (!/^\.skills\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(target))
      throw new Error('Invalid skill target path.');
    const parent = target.split('/').slice(0, -1).join('/');
    const url = `${input.baseUrl.replace(/\/+$/, '')}/api/skills/bundle?ticket=${encodeURIComponent(input.ticket)}`;
    const targetQ = shellQuote(target);
    const markerQ = shellQuote(`${target}/.opendots-version`);
    const versionQ = shellQuote(input.version);
    const command = [
      `if [ -f ${markerQ} ] && [ "$(cat ${markerQ})" = ${versionQ} ]; then echo SKILL_CURRENT; else`,
      `mkdir -p ${shellQuote(parent)} ${targetQ} && curl -fsS --max-time 30 ${shellQuote(url)} | tar --no-same-owner -xz -C ${targetQ} && printf '%s' ${versionQ} > ${markerQ} && echo SKILL_INSTALLED; fi`,
    ].join(' ');
    const result = (await this.json(
      `${base}/exec`,
      this.token(id),
      { command, timeoutMs: 60000 },
      signal,
      id,
      90_000,
    )) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      const detail =
        typeof result.stderr === 'string'
          ? result.stderr.replace(/\s+/g, ' ').trim().slice(0, 200)
          : '';
      throw new Error(`Skill install failed${detail ? `: ${detail}` : '.'}`);
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    return {
      installed: stdout.includes('SKILL_INSTALLED'),
      current: stdout.includes('SKILL_CURRENT'),
      path: target,
    };
  }
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent' = 'owner',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(computerInputs, action))
      throw new Error('Unknown computer action.');
    const parsed = computerInputs[action].parse(input);
    if (action === 'navigate') {
      // SSRF pré-proxy : le conteneur fetch directement, sans pinning
      // possible — un hôte privé est donc refusé ici, avant tout appel.
      // Résiduel documenté : rebinding DNS entre ce contrôle et le fetch
      // conteneur (voir specs/computer.md).
      const { url } = parsed as { url: string };
      try {
        await validateUrl(url);
      } catch (error) {
        throw new Error(
          `Navigation blocked (${url}): ${error instanceof Error ? error.message : 'not a public web address'}. Provide a public https:// URL.`,
          { cause: error },
        );
      }
    }
    // Journal live du terminal (start dès le lancement, end au retour).
    // Le `start` part avant les contrôles : un refus émet `start` puis `end`
    // avec l'erreur, ce qui reste informatif dans le journal.
    const watch =
      action === 'exec' ? this.beginActivity(id, actor, parsed) : null;
    return this.audited(id, action, actor, async () => {
      if (actor === 'agent' && action.startsWith('human_'))
        throw new Error('Human controls are owner-only.');
      const kind =
        action === 'exec' || action === 'git'
          ? 'shell'
          : action.startsWith('files_') || action === 'preview_file'
            ? 'files'
            : 'browser';
      this.allowed(id, kind, actor);
      const cancellation = new AbortController();
      const activeSignal = signal
        ? AbortSignal.any([signal, cancellation.signal])
        : cancellation.signal;
      const watcher = setInterval(() => {
        try {
          this.allowed(id, kind, actor);
        } catch {
          cancellation.abort();
        }
      }, 50);
      const perform = async () => {
        const url = await this.running(id, activeSignal);
        this.allowed(id, kind, actor);
        activeSignal.throwIfAborted();
        // files_search, lectures à plage et files_edit sont composés côté
        // serveur (le conteneur ne connaît que /files/list + /files/read
        // entiers + /files/write) — jamais transmis tels quels.
        if (action === 'files_send')
          return this.sendFile(
            id,
            url,
            parsed as { path: string },
            activeSignal,
          );
        if (action === 'preview_file')
          return this.previewFile(
            id,
            url,
            parsed as { path: string },
            activeSignal,
          );
        if (action === 'files_search')
          return this.searchFiles(
            url,
            id,
            parsed as { query: string; path?: string; maxResults?: number },
            activeSignal,
          );
        if (action === 'files_edit')
          return this.editFile(
            url,
            id,
            parsed as {
              path: string;
              edits: Array<{
                oldText: string;
                newText: string;
                replaceAll?: boolean;
              }>;
              expectedSha?: string;
            },
            activeSignal,
          );
        if (action === 'files_read') {
          const { offset, limit } = parsed as {
            offset?: number;
            limit?: number;
          };
          if (offset !== undefined || limit !== undefined)
            return this.readFileSlice(
              url,
              id,
              parsed as { path: string; offset?: number; limit?: number },
              activeSignal,
            );
        }
        if (action === 'git')
          return this.runGit(
            id,
            parsed as {
              op: string;
              path?: string;
              message?: string;
              ref?: string;
              url?: string;
            },
            actor,
            activeSignal,
          );
        const path = action
          .replace(/^files_/, 'files/')
          .replace(/^human_/, 'human/');
        // Exec alone gets the long deadline (installs, builds, tests);
        // everything else keeps the short wedge-recovery deadline.
        const deadline =
          action === 'exec'
            ? EXEC_DEADLINE_MS
            : Math.min(ACTION_DEADLINE_MS, this.deadlineMs);
        const result =
          action === 'exec' &&
          watch &&
          (this.activityListeners.get(id)?.size ?? 0) > 0
            ? await this.execLive(
                id,
                url,
                parsed as { command: string; timeoutMs?: number },
                activeSignal,
                watch,
              )
            : await this.json(
                `${url}/${path}`,
                this.token(id),
                ['read', 'screenshot'].includes(action) ? undefined : parsed,
                activeSignal,
                id,
                deadline,
              );
        this.allowed(id, kind, actor);
        if (
          action === 'files_read' &&
          result &&
          typeof result === 'object' &&
          typeof (result as { text?: unknown }).text === 'string'
        )
          // Atténuation TOCTOU : l'agent peut renvoyer ce sha dans
          // files_edit.expectedSha (refus si le fichier a changé).
          return {
            ...(result as Record<string, unknown>),
            sha: contentSha((result as { text: string }).text),
          };
        if (action === 'exec' && result && typeof result === 'object') {
          const copy = { ...result } as Record<string, unknown>;
          delete copy.command;
          // Borne UNIQUE des sorties exec (même constante que le journal
          // d'activité) : UI, modèle et API reçoivent pareil.
          for (const key of ['stdout', 'stderr'] as const) {
            if (
              typeof copy[key] === 'string' &&
              (copy[key] as string).length > ACTIVITY_OUTPUT_MAX
            ) {
              copy[key] =
                `${(copy[key] as string).slice(0, ACTIVITY_OUTPUT_MAX)}…[tronqué]`;
              copy.truncated = true;
            }
          }
          return copy;
        }
        return result;
      };
      // Each branch retries at most once so a persistent failure cannot loop.
      const runWithRecovery = async () => {
        let snapshotRetried = false;
        let resetRetried = false;
        for (;;) {
          try {
            return await perform();
          } catch (error) {
            // After a restart or a control handback the browser requires a fresh
            // snapshot before the next mutation. Take one (a snapshot is not a
            // mutation) and retry once. Click/type carry a ref bound to a
            // snapshot id, so only ref-less mutations are retried.
            if (
              error instanceof ComputerHttpError &&
              error.status === 409 &&
              snapshotRequired(error.payload) &&
              REFLESS_BROWSER_MUTATIONS.has(action) &&
              !snapshotRetried
            ) {
              snapshotRetried = true;
              const url = await this.running(id, activeSignal);
              await this.json(
                `${url}/snapshot`,
                this.token(id),
                {},
                activeSignal,
                id,
              );
              continue;
            }
            if (
              error instanceof ComputerHttpError &&
              error.status === 409 &&
              humanHasControl(error.payload)
            ) {
              throw new Error(
                "The owner currently has control of this Dot's computer. Release it from the Computer panel to let the agent act.",
                { cause: error },
              );
            }
            // A browser action that hit our deadline (not a caller cancellation)
            // means the browser is wedged — e.g. a stuck relaunch after the idle
            // sweep closed it. Reset the computer and try once more.
            if (
              error instanceof ComputerTimeoutError &&
              kind === 'browser' &&
              !activeSignal.aborted &&
              !resetRetried
            ) {
              resetRetried = true;
              await this.reset(id, activeSignal);
              continue;
            }
            throw error;
          }
        }
      };
      try {
        const result = await runWithRecovery();
        watch?.end(result);
        if (action === 'exec' && result && typeof result === 'object') {
          // La commande est déjà retirée et les sorties bornées dans
          // perform() ; ici on ne fait que garantir l'absence de `command`.
          const copy = { ...result } as Record<string, unknown>;
          delete copy.command;
          return copy;
        }
        return result;
      } finally {
        clearInterval(watcher);
      }
    }).then(
      (result) => result,
      (error: unknown) => {
        watch?.fail(error);
        throw error;
      },
    );
  }
}
