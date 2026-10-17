import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  computerInputs,
  computerPermissionsSchema,
  type ComputerActivityEvent,
  type ComputerAction,
  type ComputerControl,
  type ComputerStatus,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
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
 * Browser mutations that carry no element ref, so they are safe to retry after
 * taking a fresh snapshot. Click/type carry a ref bound to a snapshot id and
 * must not be replayed blindly.
 */
const REFLESS_BROWSER_MUTATIONS = new Set(['navigate', 'key', 'scroll']);
/** Bornes du flux d'activité : le terminal live montre la commande et une
 * sortie bornée, jamais un dump de 64 Ko. */
const ACTIVITY_COMMAND_MAX = 1024;
const ACTIVITY_OUTPUT_MAX = 8000;
function boundText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max)}…[tronqué]` : text;
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
  ) {}
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
  private activityListeners = new Map<string, Set<ComputerActivityListener>>();
  /** S'abonner aux événements live d'un Dot. En mémoire, mono-processus :
   * le déploiement n'exécute qu'un seul serveur, donc aucun bus externe. */
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
    return () => {
      set.delete(listener);
      if (set.size === 0) this.activityListeners.delete(dotId);
    };
  }
  private emitActivity(event: ComputerActivityEvent): void {
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
   * Périmètre `exec` uniquement (ni screenshots ni snapshots). */
  private beginActivity(
    id: string,
    actor: 'owner' | 'agent',
    parsed: unknown,
  ): { end(result: unknown): void; fail(error: unknown): void } {
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
    };
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
    // Journal live du terminal (start dès le lancement, end au retour).
    // Le `start` part avant les contrôles : un refus émet `start` puis `end`
    // avec l'erreur, ce qui reste informatif dans le journal.
    const watch =
      action === 'exec' ? this.beginActivity(id, actor, parsed) : null;
    return this.audited(id, action, actor, async () => {
      if (actor === 'agent' && action.startsWith('human_'))
        throw new Error('Human controls are owner-only.');
      const kind =
        action === 'exec'
          ? 'shell'
          : action.startsWith('files_')
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
        const path = action
          .replace(/^files_/, 'files/')
          .replace(/^human_/, 'human/');
        // Exec alone gets the long deadline (installs, builds, tests);
        // everything else keeps the short wedge-recovery deadline.
        const deadline =
          action === 'exec'
            ? EXEC_DEADLINE_MS
            : Math.min(ACTION_DEADLINE_MS, this.deadlineMs);
        const result = await this.json(
          `${url}/${path}`,
          this.token(id),
          ['read', 'screenshot'].includes(action) ? undefined : parsed,
          activeSignal,
          id,
          deadline,
        );
        this.allowed(id, kind, actor);
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
