import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import { ThinkingOrb } from './ThinkingOrb';
import type { TerminalRun } from './computer-activity';
import type { ComputerActivitySnapshot } from './useComputerActivity';

function readCollapsed(key: string): boolean {
  try {
    return (
      typeof window === 'undefined' ||
      window.localStorage.getItem(key) !== 'open'
    );
  } catch {
    return true;
  }
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    if (typeof window !== 'undefined')
      window.localStorage.setItem(key, collapsed ? 'closed' : 'open');
  } catch {
    // Storage may be disabled; the control still works for this render.
  }
}

function readLastAutoOpened(key: string): string | null {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(`${key}:last-auto-open`);
  } catch {
    return null;
  }
}

function runFailed(run: TerminalRun): boolean {
  return (
    !!run.error ||
    run.timedOut === true ||
    (typeof run.exitCode === 'number' && run.exitCode !== 0)
  );
}

function runStatus(run: TerminalRun): string {
  if (run.running) return 'En cours';
  if (run.error) return 'Refusé';
  if (run.timedOut) return 'Délai dépassé';
  if (typeof run.exitCode === 'number' && run.exitCode !== 0)
    return `Échec · ${run.exitCode}`;
  if (typeof run.elapsedMs === 'number')
    return `Terminé · ${(run.elapsedMs / 1000).toFixed(1)} s`;
  return 'Terminé';
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ComputerTerminalRun({ run }: { run: TerminalRun }) {
  const [copied, setCopied] = useState(false);
  const failed = runFailed(run);
  const output = [run.stdout, run.stderr].filter(Boolean).join('\n');
  const shortOutput = output.length <= 600 && output.split('\n').length <= 8;
  const [expanded, setExpanded] = useState(
    run.running || failed || shortOutput,
  );
  useEffect(() => {
    if (run.running || failed || shortOutput) setExpanded(true);
    else setExpanded(false);
  }, [run.running, failed, shortOutput]);
  return (
    <details
      className={`computer-terminal-run ${run.running ? 'running' : ''} ${failed ? 'failed' : ''}`}
      open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setExpanded((current) => (current === next ? current : next));
      }}
    >
      <summary className="computer-terminal-run-summary">
        <span className={`computer-terminal-actor ${run.actor}`}>
          {run.actor === 'agent' ? 'Dot' : 'Vous'}
        </span>
        <code className="computer-terminal-command">$ {run.command}</code>
        <span
          className={`computer-terminal-status ${run.running ? 'running' : failed ? 'failed' : 'done'}`}
        >
          {run.running ? <ThinkingOrb kind="working" /> : failed ? '✕' : '✓'}
          {runStatus(run)}
        </span>
        {!expanded && output && (
          <span className="computer-terminal-expand-hint">
            Cliquer pour développer
          </span>
        )}
      </summary>
      <div className="computer-terminal-run-output">
        {run.error && <p className="computer-terminal-stderr">{run.error}</p>}
        {run.running && (
          <p className="computer-terminal-running">Commande en cours…</p>
        )}
        {!run.running && !run.error && !output && (
          <p className="computer-terminal-empty-output">Aucune sortie.</p>
        )}
        {run.stdout && <pre>{run.stdout}</pre>}
        {run.stderr && (
          <pre className="computer-terminal-stderr">{run.stderr}</pre>
        )}
        {run.truncated && (
          <p className="computer-terminal-meta">Sortie tronquée.</p>
        )}
        {output && (
          <button
            type="button"
            className="computer-terminal-copy"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void copyText(output).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
            aria-label="Copier la sortie terminal"
          >
            <Copy size={13} /> {copied ? 'Copié' : 'Copier'}
          </button>
        )}
      </div>
    </details>
  );
}

export function ComputerTerminalRunList({
  runs,
  empty = 'Aucune commande pour l’instant.',
  compact = false,
}: {
  runs: TerminalRun[];
  empty?: string;
  compact?: boolean;
}) {
  if (!runs.length) return <p className="computer-terminal-empty">{empty}</p>;
  return (
    <ol
      className={`computer-terminal-log ${compact ? 'compact' : ''}`}
      aria-label="Journal terminal"
    >
      {runs.map((run) => (
        <li key={run.key}>
          <ComputerTerminalRun run={run} />
        </li>
      ))}
    </ol>
  );
}

export function LiveTerminalStrip({
  dotId,
  dotName,
  activity,
  onOpenTerminal,
}: {
  dotId: string;
  dotName: string;
  activity: ComputerActivitySnapshot;
  onOpenTerminal?: () => void;
}) {
  const storageKey = `nevadots-terminal-strip:${dotId}`;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const autoOpened = useRef<string | null>(readLastAutoOpened(storageKey));
  const latestAgentRun = [...activity.runs]
    .reverse()
    .find((run) => run.actor === 'agent');

  useEffect(() => {
    autoOpened.current = readLastAutoOpened(storageKey);
    setCollapsed(readCollapsed(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!latestAgentRun || autoOpened.current === latestAgentRun.key) return;
    autoOpened.current = latestAgentRun.key;
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem(
          `${storageKey}:last-auto-open`,
          latestAgentRun.key,
        );
    } catch {
      // Auto-open remains session-local when storage is unavailable.
    }
    setCollapsed(false);
    writeCollapsed(storageKey, false);
  }, [latestAgentRun?.key, storageKey]);

  const toggle = () => {
    setCollapsed((value) => {
      const next = !value;
      writeCollapsed(storageKey, next);
      return next;
    });
  };
  const latest = activity.runs.at(-1);

  return (
    <section
      className={`live-terminal-strip ${collapsed ? 'collapsed' : ''}`}
      aria-label={`Terminal en direct de ${dotName}`}
    >
      <div className="live-terminal-strip-head">
        <button
          type="button"
          className="live-terminal-strip-toggle"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          <span
            className={`live-terminal-indicator ${activity.error ? 'error' : activity.connected ? 'connected' : ''}`}
          />
          <strong>Terminal</strong>
          <span className="live-terminal-strip-latest">
            {latest
              ? `$ ${latest.command}`
              : activity.error
                ? 'Journal indisponible'
                : 'En attente des commandes du Dot'}
          </span>
        </button>
        {onOpenTerminal && (
          <button
            type="button"
            className="live-terminal-open"
            onClick={onOpenTerminal}
            title="Ouvrir le terminal complet"
          >
            <ExternalLink size={14} />
            <span>Ouvrir</span>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="live-terminal-strip-body">
          {activity.error && (
            <p className="computer-error" role="status">
              {activity.error}
            </p>
          )}
          <ComputerTerminalRunList
            runs={activity.runs.slice(-3)}
            compact
            empty={
              activity.connected
                ? 'Le terminal est prêt. Les commandes du Dot apparaîtront ici.'
                : 'Connexion au journal terminal…'
            }
          />
        </div>
      )}
    </section>
  );
}
