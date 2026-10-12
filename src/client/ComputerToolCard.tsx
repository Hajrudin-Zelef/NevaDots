import { useEffect, useState } from 'react';
import { FileText, Globe, Terminal } from 'lucide-react';
import { z } from 'zod';
import { api } from './api';
import { computerToolResult } from '../shared/activity';

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
  running,
  onExpand,
}: ComputerToolRenderProps & {
  dotId: string;
  dotName: string;
  showScreen: boolean;
  running: boolean;
  onExpand?: () => void;
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
  const title =
    action === 'exec' ? 'Terminal' : isFiles ? 'Fichiers' : 'Navigateur';
  const Icon = action === 'exec' ? Terminal : isFiles ? FileText : Globe;
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
      {action === 'exec' && complete && typeof data.stdout === 'string' && (
        <pre aria-label="Sortie terminal">{data.stdout.slice(0, 4000)}</pre>
      )}
      {action === 'exec' &&
        complete &&
        typeof data.stderr === 'string' &&
        data.stderr && <pre>{data.stderr.slice(0, 2000)}</pre>}
      {showScreen && (
        <div className="muse-preview">
          {screen ? (
            <img
              src={`data:image/png;base64,${screen.base64}`}
              alt={`Écran du navigateur de ${dotName}`}
            />
          ) : (
            <div className="muse-preview-empty" role="status">
              {screenError || 'Connexion au navigateur…'}
            </div>
          )}
        </div>
      )}
      {onExpand && (
        <button type="button" className="muse-open" onClick={onExpand}>
          Ouvrir l’aperçu
        </button>
      )}
    </section>
  );
}
