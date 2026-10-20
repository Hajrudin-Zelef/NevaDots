import type { ComputerActivityEvent } from '../shared/computer-types.js';

/** One shell run shown in the live terminal journal (start + end merged). */
export interface TerminalRun {
  key: string;
  actor: 'owner' | 'agent';
  command: string;
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
      if (
        parsed &&
        (parsed.phase === 'start' ||
          parsed.phase === 'chunk' ||
          parsed.phase === 'end') &&
        typeof parsed.command === 'string' &&
        (parsed.actor === 'owner' || parsed.actor === 'agent')
      )
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
  if (event.phase === 'start') {
    const run: TerminalRun = {
      key: `${event.at}-${event.actor}-${runs.length}`,
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
