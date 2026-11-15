import type { ComputerActivityEvent } from '../shared/computer-types.js';

/** One journal line: a shell run (streamed, expandable) or a finished
 * computer action (navigation, file write, screenshot… — one line). */
export interface TerminalRun {
  key: string;
  /** `exec` défile (sortie dépliable) ; `action` est une ligne d'action. */
  kind: 'exec' | 'action';
  actor: 'owner' | 'agent';
  /** Commande (exec) ou nom d'action (`files_edit`, `navigate`…). */
  command: string;
  /** Issue d'une action terminée (jamais sur un exec). */
  outcome?: 'succeeded' | 'failed';
  /** Occurrences coalescées d'une même action consécutive (défaut 1). */
  count?: number;
  startedAt: number;
  running: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
  elapsedMs?: number;
  error?: string;
}

/** Journal borné : les longues sessions ne font pas grossir le DOM. */
export const TERMINAL_RUN_CAP = 200;
/** Fenêtre de fusion de deux actions identiques consécutives (2 min). */
export const ACTION_MERGE_WINDOW_MS = 120_000;
/** Garde-fou d'affichage par run (le serveur borne déjà à 8 Ko). */
export const TERMINAL_OUTPUT_CAP = 20000;

/** Découpe un flux NDJSON en événements complets (garde la fin incomplète). */
export function parseActivityChunk(
  carry: string,
  chunk: string,
): { events: ComputerActivityEvent[]; carry: string } {
  const text = carry + chunk;
  const lines = text.split('\n');
  const nextCarry = lines.pop() ?? '';
  const events: ComputerActivityEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ComputerActivityEvent>;
      const actorOk = parsed.actor === 'owner' || parsed.actor === 'agent';
      const execOk =
        parsed.action === 'exec' &&
        (parsed.phase === 'start' ||
          parsed.phase === 'chunk' ||
          parsed.phase === 'end') &&
        typeof (parsed as { command?: unknown }).command === 'string';
      const actionOk =
        parsed.action === 'action' &&
        parsed.phase === 'action' &&
        typeof (parsed as { name?: unknown }).name === 'string';
      if (parsed && actorOk && (execOk || actionOk))
        events.push(parsed as ComputerActivityEvent);
    } catch {
      // Ligne incomplète ou étrangère : ignorée (la suivante complètera).
    }
  }
  return { events, carry: nextCarry };
}

/** Intègre un événement live au journal (fusionne `chunk`/`end` sur son `start`). */
export function appendActivityRun(
  runs: TerminalRun[],
  event: ComputerActivityEvent,
): TerminalRun[] {
  if (event.action === 'action') {
    // Rafale d'actions identiques (clics, frappes…) : une seule ligne avec
    // un compteur, sinon le journal défile sans rien dire.
    const last = runs[runs.length - 1];
    if (
      last &&
      last.kind === 'action' &&
      last.command === event.name &&
      last.actor === event.actor &&
      event.at - last.startedAt < ACTION_MERGE_WINDOW_MS
    ) {
      const next = [...runs];
      next[next.length - 1] = {
        ...last,
        count: (last.count ?? 1) + 1,
        outcome: event.outcome,
        startedAt: event.at,
      };
      return next;
    }
    // Action terminée : une ligne, sans sortie (le shell a son propre flux).
    const run: TerminalRun = {
      key: `${event.at}-${event.actor}-${runs.length}`,
      kind: 'action',
      actor: event.actor,
      command: event.name,
      outcome: event.outcome,
      startedAt: event.at,
      running: false,
      stdout: '',
      stderr: '',
    };
    return [...runs, run].slice(-TERMINAL_RUN_CAP);
  }
  if (event.phase === 'start') {
    const run: TerminalRun = {
      key: `${event.at}-${event.actor}-${runs.length}`,
      kind: 'exec',
      actor: event.actor,
      command: event.command,
      startedAt: event.at,
      running: true,
      stdout: '',
      stderr: '',
    };
    return [...runs, run].slice(-TERMINAL_RUN_CAP);
  }
  if (event.phase === 'chunk') {
    // Défilement live : ajoute le fragment au run en cours le plus récent
    // (même acteur + commande). Sans `start` préalable, on ignore.
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (
        run.running &&
        run.actor === event.actor &&
        run.command === event.command
      ) {
        const stdout = run.stdout + (event.chunk ?? '');
        const stderr = run.stderr + (event.chunkStderr ?? '');
        const next = [...runs];
        next[i] = {
          ...run,
          // Le journal garde la fin (ce qui défile) plutôt que le début.
          stdout: stdout.slice(-TERMINAL_OUTPUT_CAP),
          stderr: stderr.slice(-TERMINAL_OUTPUT_CAP),
          truncated:
            run.truncated ||
            stdout.length > TERMINAL_OUTPUT_CAP ||
            stderr.length > TERMINAL_OUTPUT_CAP,
        };
        return next;
      }
    }
    return runs;
  }
  const closed: TerminalRun = {
    key: `${event.at}-${event.actor}-${runs.length}`,
    kind: 'exec',
    actor: event.actor,
    command: event.command,
    startedAt: event.at,
    running: false,
    exitCode: event.exitCode,
    stdout: (event.stdout ?? '').slice(0, TERMINAL_OUTPUT_CAP),
    stderr: (event.stderr ?? '').slice(0, TERMINAL_OUTPUT_CAP),
    truncated: event.truncated,
    timedOut: event.timedOut,
    elapsedMs: event.elapsedMs,
    error: event.error,
  };
  let index = -1;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (
      runs[i].running &&
      runs[i].actor === event.actor &&
      runs[i].command === event.command
    ) {
      index = i;
      break;
    }
  }
  if (index < 0) return [...runs, closed].slice(-TERMINAL_RUN_CAP);
  const next = [...runs];
  next[index] = { ...next[index], ...closed, key: next[index].key };
  return next;
}
