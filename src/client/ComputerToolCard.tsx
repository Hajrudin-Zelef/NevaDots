import { useEffect, useMemo, useState } from 'react';
import { FileText, Globe, Terminal } from 'lucide-react';
import { z } from 'zod';
import { api } from './api';
import { ThinkingOrb } from './ThinkingOrb';
import { computerToolResult } from '../shared/activity';
import { useComputerActivity } from './useComputerActivity';

const screenSchema = z.object({
  base64: z
    .string()
    .regex(/^[A-Za-z0-9+/=]+$/)
    .max(4_000_000),
  url: z.string(),
});
export type ComputerToolRenderProps = {
  name: string;
  toolCallId: string;
  status: string;
  args?: unknown;
  result?: unknown;
};
const labels: Record<string, string> = {
  navigate: 'Ouvre un site',
  snapshot: 'Inspecte la page',
  read: 'Lit la page',
  screenshot: 'Vue du navigateur',
  click: 'Clique dans le navigateur',
  type: 'Saisit dans le navigateur',
  key: 'Utilise le clavier',
  scroll: 'Fait défiler la page',
  files_write: 'Enregistre un fichier',
  files_read: 'Lit un fichier',
  files_list: 'Liste les fichiers',
  exec: 'Commande terminal',
};
export function ComputerToolCard({
  name,
  status,
  args,
  result,
  dotId,
  dotName,
  showScreen,
  showTerminal,
  running,
  onExpand,
  onExpandTerminal,
}: ComputerToolRenderProps & {
  dotId: string;
  dotName: string;
  showScreen: boolean;
  showTerminal?: boolean;
  running: boolean;
  onExpand?: () => void;
  onExpandTerminal?: () => void;
}) {
  const [screen, setScreen] = useState<z.infer<typeof screenSchema>>();
  const [screenError, setScreenError] = useState('');
  const action = name.replace(/^computer_/, '');
  const data = computerToolResult(result);
  const parameters = computerToolResult(args);
  const interrupted =
    data.status === 'stopped' || data.reason === 'stop_requested';
  const error =
    typeof data.error === 'string'
      ? data.error
      : data.status === 'error' && typeof data.message === 'string'
        ? data.message
        : '';
  const interruption =
    interrupted && typeof data.message === 'string' ? data.message : '';
  const complete = status === 'complete';
  const failed =
    data.status === 'error' ||
    !!error ||
    (typeof data.exitCode === 'number' && data.exitCode !== 0);
  const state = interrupted
    ? 'Interrompu'
    : failed
      ? 'À vérifier'
      : complete
        ? 'Terminé'
        : running
          ? 'En cours'
          : 'Interrompu';
  const detail =
    typeof parameters.url === 'string'
      ? parameters.url
      : typeof parameters.path === 'string'
        ? parameters.path
        : '';
  useEffect(() => {
    if (!showScreen) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setScreen(undefined);
    setScreenError('');
    const refresh = async () => {
      if (!document.hidden) {
        try {
          const value = await api<unknown>(
            `/dots/${encodeURIComponent(dotId)}/computer/actions`,
            'POST',
            { action: 'screenshot', input: {} },
            controller.signal,
          );
          const next = screenSchema.parse(value);
          if (!controller.signal.aborted) {
            setScreen(next);
            setScreenError('');
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            setScreen(undefined);
            setScreenError(
              cause instanceof Error
                ? cause.message
                : 'Computer preview unavailable.',
            );
          }
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [dotId, showScreen]);
  const isFiles = action.startsWith('files_');
  const isExec = action === 'exec';
  const title = isExec ? 'Terminal' : isFiles ? 'Fichiers' : 'Navigateur';
  const Icon = isExec ? Terminal : isFiles ? FileText : Globe;
  // Aperçu terminal en direct, même principe que l'aperçu navigateur :
  // le flux SSE partagé donne la sortie live pendant l'exec, puis le
  // résultat final une fois terminé. Actif seulement sur la carte exec
  // la plus récente pour ne pas multiplier les abonnements visibles.
  const terminalFeed = useComputerActivity(
    dotId,
    isExec && showTerminal === true,
  );
  const execCommand =
    typeof parameters.command === 'string' ? parameters.command : '';
  const liveRun = useMemo(() => {
    if (!isExec) return undefined;
    const runs = terminalFeed.runs;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (execCommand && runs[i].command === execCommand) return runs[i];
    }
    return [...runs].reverse().find((run) => run.actor === 'agent');
  }, [isExec, terminalFeed.runs, execCommand]);
  const liveStdout = liveRun?.stdout ?? '';
  const liveStderr = liveRun?.stderr ?? '';
  const liveOutput = [liveStdout, liveStderr].filter(Boolean).join('\n');
  const finalStdout = typeof data.stdout === 'string' ? data.stdout : '';
  const finalStderr = typeof data.stderr === 'string' ? data.stderr : '';
  const previewOutput = (
    liveOutput || [finalStdout, finalStderr].filter(Boolean).join('\n')
  ).slice(0, 4000);
  const previewRunning = liveRun?.running ?? (!complete && running);
  const expandTerminal = onExpandTerminal ?? onExpand;
  return (
    <section
      className={`inline-computer muse-tool ${showScreen ? 'with-screen' : ''} ${
        failed ? 'failed' : ''
      }`}
      aria-label={`${dotName} · ${labels[action] ?? action}`}
    >
      <header className="muse-tool-head">
        <span className="muse-tool-icon">
          <Icon size={16} aria-hidden="true" />
        </span>
        <span className="muse-tool-titles">
          <strong>{title}</strong>
          <span className={`muse-tool-sub ${failed ? 'failed' : ''}`}>
            {state} · {labels[action] ?? 'Ordinateur'}
          </span>
        </span>
      </header>
      {detail && (
        <div className="inline-computer-detail" title={detail}>
          {detail}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {interruption && <p role="status">{interruption}</p>}
      {isExec && showTerminal === true && (
        <div className="muse-preview muse-preview-terminal">
          <div className="muse-preview-terminal-head">
            <code>$ {execCommand || 'terminal'}</code>
            <span className="muse-preview-terminal-status">
              {previewRunning ? (
                <>
                  <ThinkingOrb kind="working" /> En cours…
                </>
              ) : (
                state
              )}
            </span>
          </div>
          {previewOutput ? (
            <pre aria-label="Aperçu terminal">{previewOutput}</pre>
          ) : (
            <div className="muse-preview-empty" role="status">
              <ThinkingOrb kind="connecting" size={32} />
              {terminalFeed.error || 'Connexion au terminal…'}
            </div>
          )}
        </div>
      )}
      {isExec && showTerminal !== true && complete && finalStdout && (
        <pre aria-label="Sortie terminal">{finalStdout.slice(0, 4000)}</pre>
      )}
      {isExec && showTerminal !== true && complete && finalStderr && (
        <pre>{finalStderr.slice(0, 2000)}</pre>
      )}
      {showScreen && (
        <div className="muse-preview">
          {screen ? (
            <img
              src={`data:image/png;base64,${screen.base64}`}
              alt={`Écran du navigateur de ${dotName}`}
            />
          ) : (
            <div className="muse-preview-empty" role="status">
              <ThinkingOrb kind="connecting" size={32} />
              {screenError || 'Connexion au navigateur…'}
            </div>
          )}
        </div>
      )}
      {(isExec ? (expandTerminal ?? onExpand) : onExpand) && (
        <button
          type="button"
          className="muse-open"
          onClick={isExec ? (expandTerminal ?? onExpand) : onExpand}
        >
          {isExec ? 'Ouvrir le terminal' : 'Ouvrir l’aperçu'}
        </button>
      )}
    </section>
  );
}
