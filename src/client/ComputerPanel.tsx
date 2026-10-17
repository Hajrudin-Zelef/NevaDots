import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import type { Dot } from '../shared/types';
import type { ComputerAction, ComputerStatus } from '../shared/computer-types';
import { api } from './api';
import { BrowserScreen } from './BrowserScreen';
import { ThinkingOrb } from './ThinkingOrb';
import { useComputerActivity } from './useComputerActivity';
import {
  fileBasename,
  formatFileSize,
  parentDir,
  sortFileEntries,
  type ComputerFileEntry,
} from './computer-files';

type Screen = {
  base64: string;
  width: number;
  height: number;
  url: string;
  capturedAt: number;
};

const STATE_LABEL: Record<string, string> = {
  running: 'en marche',
  stopped: 'arrêté',
  unavailable: 'indisponible',
  not_configured: 'non configuré',
};

export function ComputerPanel({ dot }: { dot: Dot }) {
  const [tab, setTab] = useState<'Browser' | 'Files' | 'Terminal' | 'Activity'>(
    'Browser',
  );
  const [status, setStatus] = useState<ComputerStatus>();
  const [screen, setScreen] = useState<Screen>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [key, setKey] = useState('Enter');
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState('');
  const [contents, setContents] = useState('');
  const [command, setCommand] = useState('');
  const [screenError, setScreenError] = useState('');
  // Navigateur de fichiers : état dédié, jamais dans la « Sortie » brute.
  const [filesDir, setFilesDir] = useState('');
  const [filesEntries, setFilesEntries] = useState<ComputerFileEntry[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [filesListed, setFilesListed] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [filesNotice, setFilesNotice] = useState('');
  const [append, setAppend] = useState(false);
  // True while the user edits the address bar, so the screenshot poll does not
  // overwrite what they are typing.
  const urlDirty = useRef(false);
  const lifecycle = useRef({
    active: false,
    revision: 0,
    busy: false,
    loaded: false,
    running: false,
  });
  const controller = useRef<AbortController | null>(null);
  const base = `/dots/${encodeURIComponent(dot.id)}/computer`;
  const refresh = useCallback(async () => {
    const revision = lifecycle.current.revision;
    const current = () =>
      lifecycle.current.active && revision === lifecycle.current.revision;
    try {
      const next = await api<ComputerStatus>(
        base,
        'GET',
        undefined,
        controller.current?.signal,
      );
      if (!current()) return;
      setStatus(next);
      lifecycle.current.loaded = true;
      lifecycle.current.running = next.state === 'running';
      setError('');
      if (
        next.state === 'running' &&
        next.permissions.browser &&
        next.permissions.enabled
      ) {
        try {
          const capture = await api<Screen>(
            `${base}/actions`,
            'POST',
            { action: 'screenshot', input: {} },
            controller.current?.signal,
          );
          if (current()) {
            setScreen(capture);
            setScreenError('');
            if (!urlDirty.current && capture.url) setUrl(capture.url);
          }
        } catch (cause) {
          if (current()) {
            setScreen(undefined);
            setScreenError(
              cause instanceof Error
                ? cause.message
                : 'Impossible d’actualiser l’écran.',
            );
          }
        }
      } else {
        setScreen(undefined);
        setScreenError('');
      }
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Impossible de charger l’ordinateur.',
        );
        setScreen(undefined);
      }
    }
  }, [base]);
  useEffect(() => {
    lifecycle.current.active = true;
    controller.current = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (
        !document.hidden &&
        !lifecycle.current.busy &&
        (!lifecycle.current.loaded || lifecycle.current.running)
      )
        await refresh();
      if (!cancelled && lifecycle.current.active)
        timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      cancelled = true;
      lifecycle.current.active = false;
      lifecycle.current.revision++;
      controller.current?.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  const run = async (endpoint: string, body: unknown = {}, method = 'POST') => {
    if (lifecycle.current.busy) return;
    lifecycle.current.busy = true;
    lifecycle.current.revision++;
    setBusy(true);
    setError('');
    try {
      const result = await api<unknown>(
        `${base}${endpoint}`,
        method,
        body,
        controller.current?.signal,
      );
      if (!lifecycle.current.active) return;
      await refresh();
      return result;
    } catch (cause) {
      if (!lifecycle.current.active) return;
      setError(
        cause instanceof Error ? cause.message : 'Computer action failed.',
      );
    } finally {
      lifecycle.current.busy = false;
      if (lifecycle.current.active) setBusy(false);
    }
  };
  const action = (action: ComputerAction, input: unknown) =>
    run('/actions', { action, input }, 'POST');
  // Appels fichiers : même garde anti-concurrence que `run`, mais les erreurs
  // vont dans le bandeau de l'onglet Fichiers (pas dans la « Sortie » brute).
  const fileAction = async (
    fileActionName: ComputerAction,
    input: unknown,
  ): Promise<unknown> => {
    if (lifecycle.current.busy) return undefined;
    lifecycle.current.busy = true;
    lifecycle.current.revision++;
    setBusy(true);
    setFilesError('');
    setFilesNotice('');
    try {
      const result = await api<unknown>(
        `${base}/actions`,
        'POST',
        { action: fileActionName, input },
        controller.current?.signal,
      );
      if (!lifecycle.current.active) return undefined;
      await refresh();
      return result;
    } catch (cause) {
      if (!lifecycle.current.active) return undefined;
      setFilesError(
        cause instanceof Error ? cause.message : 'Échec de l’action fichier.',
      );
      return undefined;
    } finally {
      lifecycle.current.busy = false;
      if (lifecycle.current.active) setBusy(false);
    }
  };
  const listDir = async (dir: string): Promise<void> => {
    const result = await fileAction('files_list', { path: dir });
    if (!lifecycle.current.active || result === undefined) return;
    if (
      result &&
      typeof result === 'object' &&
      'entries' in result &&
      Array.isArray(result.entries)
    ) {
      setFilesEntries(sortFileEntries(result.entries as ComputerFileEntry[]));
      setFilesTruncated('truncated' in result && result.truncated === true);
      setFilesDir(
        'path' in result && typeof result.path === 'string' ? result.path : dir,
      );
      setFilesListed(true);
    } else {
      setFilesError('Réponse de liste inattendue.');
    }
  };
  const readFile = async (filePath: string): Promise<void> => {
    const result = await fileAction('files_read', { path: filePath });
    if (!lifecycle.current.active || result === undefined) return;
    if (
      result &&
      typeof result === 'object' &&
      'text' in result &&
      typeof result.text === 'string'
    ) {
      setContents(result.text);
    } else {
      setFilesError('Réponse de lecture inattendue.');
    }
  };
  const writeFile = async (): Promise<void> => {
    const target = path.trim();
    if (!target) return;
    if (
      !append &&
      filesEntries.some((entry) => entry.path === target) &&
      !window.confirm(`Écraser « ${target} » ?`)
    )
      return;
    const result = await fileAction('files_write', {
      path: target,
      contents,
      ...(append ? { append: true } : {}),
    });
    if (!lifecycle.current.active || result === undefined) return;
    await listDir(filesDir);
    if (lifecycle.current.active)
      setFilesNotice(`Enregistré « ${target} »${append ? ' (ajouté)' : ''}.`);
  };
  const running = status?.state === 'running' && status.permissions.enabled;
  const human =
    status?.control?.holder === 'human' && !status.control.transitioning;
  const browser = !!running && !!status?.permissions.browser;
  // Journal live du terminal (commandes owner + agent) quand l'onglet est ouvert.
  const terminal = useComputerActivity(dot.id, tab === 'Terminal');
  return (
    <section
      className="computer-panel"
      aria-label={`Ordinateur de ${dot.name}`}
      aria-busy={busy}
    >
      {error && (
        <p className="computer-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <p role="status">
          <ThinkingOrb kind="loading" />{' '}
          {error ? 'Statut indisponible.' : 'Chargement…'}
        </p>
      ) : (
        <>
          <div className="computer-status">
            <strong>{STATE_LABEL[status.state] ?? status.state}</strong>
            {status.state !== 'running' && (
              <button disabled={busy} onClick={() => void refresh()}>
                Rafraîchir
              </button>
            )}
            <span>
              {busy ? (
                <>
                  <ThinkingOrb kind="working" /> Travail…
                </>
              ) : human ? (
                'Vous avez le contrôle'
              ) : (
                `Contrôle de ${dot.name}`
              )}
            </span>
          </div>
          {!status.configured && (
            <div className="computer-setup">
              <h3>Connecter un service d’ordinateur</h3>
              <p>
                Ce Dot n’a pas de service d’ordinateur configuré. Configurez
                l’URL et le jeton du service, puis redémarrez. Chaque Dot
                obtient son propre navigateur et son espace.
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/COMPUTERS.md"
                target="_blank"
                rel="noreferrer"
              >
                Guide de configuration ↗
              </a>
            </div>
          )}
          {status.error && (
            <p className="computer-error" role="alert">
              {status.error}
            </p>
          )}
          <div
            className="computer-tool-tabs"
            role="tablist"
            aria-label="Outils de l’ordinateur"
          >
            {(
              [
                ['Browser', 'Navigateur'],
                ['Files', 'Fichiers'],
                ['Terminal', 'Terminal'],
                ['Activity', 'Activité'],
              ] as const
            ).map(([id, label]) => (
              <button
                role="tab"
                aria-selected={tab === id}
                key={id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {status.configured && (
            <>
              <section
                className="computer-section computer-browser muse-browser"
                hidden={tab !== 'Browser'}
              >
                {!status.permissions.browser && (
                  <p>Activez la permission Navigateur pour voir l’écran.</p>
                )}
                <div className="browser-chrome">
                  <button
                    type="button"
                    className="browser-reload"
                    aria-label="Recharger la page"
                    title="Recharger"
                    disabled={!browser || busy || human}
                    onClick={() => {
                      const target = (url || screen?.url || '').trim();
                      if (target) {
                        urlDirty.current = false;
                        void action('navigate', { url: target });
                      }
                    }}
                  >
                    <RotateCw size={15} />
                  </button>
                  <form
                    className="browser-url"
                    onSubmit={(event) => {
                      event.preventDefault();
                      urlDirty.current = false;
                      void action('navigate', { url });
                    }}
                  >
                    <input
                      type="url"
                      aria-label="Adresse"
                      placeholder="https://example.com"
                      value={url}
                      onChange={(event) => {
                        urlDirty.current = true;
                        setUrl(event.target.value);
                      }}
                      disabled={!browser || busy || human}
                    />
                  </form>
                  <button
                    type="button"
                    className={`browser-control ${human ? 'active' : ''}`}
                    disabled={
                      (!human && !browser) ||
                      busy ||
                      Boolean(status.control?.transitioning)
                    }
                    onClick={() => void run(human ? '/release' : '/take')}
                  >
                    {human
                      ? 'Rendre le contrôle'
                      : 'Prendre le contrôle du navigateur'}
                  </button>
                </div>
                <div className="browser-tab" title={screen?.url}>
                  <span className="browser-tab-dot" />
                  <span className="browser-tab-title">
                    {screen?.url
                      ? screen.url.replace(/^https?:\/\//, '').split('/')[0]
                      : 'newtab'}
                  </span>
                </div>
                {screenError && (
                  <p className="computer-error" role="status">
                    {screenError}
                  </p>
                )}
                {browser && running ? (
                  <>
                    <BrowserScreen
                      dotId={dot.id}
                      active={tab === 'Browser'}
                      interactive={human}
                    />
                    <small>
                      {human
                        ? 'Vous avez le contrôle : cliquez, tapez et défilez directement dans la page.'
                        : 'Cliquez « Prendre le contrôle du navigateur » pour interagir.'}
                    </small>
                  </>
                ) : (
                  <p className="computer-screen-empty">
                    Démarrez l’ordinateur avec la permission Navigateur.
                  </p>
                )}
                {status.control?.transitioning && (
                  <p role="status">Transfert du contrôle…</p>
                )}
                {human && (
                  <details className="computer-human">
                    <summary>Clavier & contrôles précis</summary>
                    <p>
                      Cliquez l’écran ou saisissez des coordonnées ci-dessous.
                      Le texte va directement à ce navigateur, hors du chat.
                      Rendez le contrôle quand vous avez fini.
                    </p>
                    <form
                      className="computer-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action('human_click', point);
                      }}
                    >
                      <label>
                        X
                        <input
                          type="number"
                          min="0"
                          max={screen ? screen.width - 1 : undefined}
                          value={point.x}
                          onChange={(event) =>
                            setPoint({
                              ...point,
                              x: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Y
                        <input
                          type="number"
                          min="0"
                          max={screen ? screen.height - 1 : undefined}
                          value={point.y}
                          onChange={(event) =>
                            setPoint({
                              ...point,
                              y: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <button disabled={busy || !browser || !screen}>
                        Cliquer
                      </button>
                    </form>
                    <form
                      className="computer-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const value = text;
                        setText('');
                        void action('human_type', { text: value });
                      }}
                    >
                      <input
                        type="password"
                        aria-label="Texte à saisir"
                        placeholder="Saisir dans le champ actif"
                        autoComplete="off"
                        value={text}
                        maxLength={20000}
                        onChange={(event) => setText(event.target.value)}
                      />
                      <button disabled={busy || !browser || !text}>
                        Saisir
                      </button>
                    </form>
                    <form
                      className="computer-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action('human_key', { key });
                      }}
                    >
                      <select
                        aria-label="Touche à presser"
                        value={key}
                        onChange={(event) => setKey(event.target.value)}
                      >
                        {[
                          'Enter',
                          'Tab',
                          'Escape',
                          'Backspace',
                          'ArrowUp',
                          'ArrowDown',
                          'ArrowLeft',
                          'ArrowRight',
                        ].map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                      <button disabled={busy || !browser}>Touche</button>
                    </form>
                    <div className="computer-actions">
                      <button
                        disabled={busy || !browser}
                        onClick={() =>
                          void action('human_scroll', { deltaY: -500 })
                        }
                      >
                        Monter
                      </button>
                      <button
                        disabled={busy || !browser}
                        onClick={() =>
                          void action('human_scroll', { deltaY: 500 })
                        }
                      >
                        Descendre
                      </button>
                    </div>
                  </details>
                )}
              </section>
              <details
                className="computer-section"
                open
                hidden={tab !== 'Files'}
              >
                <summary>Fichiers du workspace</summary>
                <p>
                  Les chemins sont relatifs à l’espace persistant de ce Dot.
                </p>
                {filesError && (
                  <p className="computer-error" role="alert">
                    {filesError}
                  </p>
                )}
                {filesNotice && <p role="status">{filesNotice}</p>}
                <div className="computer-actions">
                  <button
                    disabled={!running || !status.permissions.files || busy}
                    onClick={() => void listDir(filesDir)}
                  >
                    {filesListed ? 'Actualiser' : 'Lister'}
                  </button>
                  {filesDir && (
                    <button
                      disabled={!running || !status.permissions.files || busy}
                      onClick={() => void listDir(parentDir(filesDir))}
                    >
                      ↑ Remonter
                    </button>
                  )}
                </div>
                {filesListed && (
                  <>
                    <p>
                      Dossier :{' '}
                      <strong>
                        {filesDir ? `/${filesDir}` : '/ (racine)'}
                      </strong>
                    </p>
                    {filesTruncated && (
                      <p role="status">
                        Liste tronquée : affinez le dossier pour tout voir.
                      </p>
                    )}
                    {filesEntries.length === 0 ? (
                      <p>Dossier vide.</p>
                    ) : (
                      <ul className="computer-files">
                        {filesEntries.map((entry) => (
                          <li key={entry.path}>
                            <button
                              type="button"
                              title={entry.path}
                              disabled={
                                !running || !status.permissions.files || busy
                              }
                              onClick={() => {
                                if (entry.kind === 'dir') {
                                  void listDir(entry.path);
                                } else {
                                  setPath(entry.path);
                                  void readFile(entry.path);
                                }
                              }}
                            >
                              {entry.kind === 'dir' ? '📁' : '📄'}{' '}
                              {fileBasename(entry.path)}
                              {entry.kind !== 'dir' &&
                                ` · ${formatFileSize(entry.bytes)}`}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                <label>
                  Chemin
                  <input
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder="notes.txt"
                    disabled={!running || !status.permissions.files || busy}
                  />
                </label>
                <div className="computer-actions">
                  <button
                    disabled={
                      !running ||
                      !status.permissions.files ||
                      busy ||
                      !path.trim()
                    }
                    onClick={() => void readFile(path.trim())}
                  >
                    Lire
                  </button>
                </div>
                <label>
                  Contenu du fichier ({contents.length} caractères)
                  <textarea
                    aria-label="Contenu à enregistrer"
                    value={contents}
                    onChange={(event) => setContents(event.target.value)}
                    disabled={!running || !status.permissions.files || busy}
                    maxLength={100000}
                    rows={5}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={append}
                    onChange={(event) => setAppend(event.target.checked)}
                    disabled={!running || !status.permissions.files || busy}
                  />{' '}
                  Ajouter à la fin au lieu de remplacer
                </label>
                <button
                  disabled={
                    !running ||
                    !status.permissions.files ||
                    busy ||
                    !path.trim()
                  }
                  onClick={() => void writeFile()}
                >
                  {append ? 'Ajouter à la fin' : 'Enregistrer (remplacer)'}
                </button>
                {!status.permissions.files && (
                  <p>
                    Activez la permission Fichiers pour utiliser ces contrôles.
                  </p>
                )}
              </details>
              <details
                className="computer-section"
                open
                hidden={tab !== 'Terminal'}
              >
                <summary>Terminal</summary>
                <p>
                  S’exécute dans l’ordinateur de ce Dot. Les commandes
                  s’arrêtent après 30 secondes. Le journal ci-dessous suit en
                  direct vos commandes et celles du Dot.
                </p>
                {terminal.error && (
                  <p className="computer-error" role="alert">
                    {terminal.error}
                  </p>
                )}
                <p role="status">
                  {terminal.connected
                    ? 'Journal en direct.'
                    : 'Connexion au journal…'}
                </p>
                <ol
                  className="computer-terminal-log"
                  aria-label="Journal terminal"
                >
                  {terminal.runs.map((run) => (
                    <li key={run.key}>
                      <div className="computer-terminal-cmd">
                        <span
                          className={`computer-terminal-actor ${run.actor}`}
                        >
                          {run.actor === 'agent' ? 'Dot' : 'Vous'}
                        </span>
                        <code>$ {run.command}</code>
                      </div>
                      {run.running ? (
                        <p className="computer-terminal-running" role="status">
                          <ThinkingOrb kind="working" /> En cours…
                        </p>
                      ) : run.error ? (
                        <p className="computer-error" role="alert">
                          {run.error}
                        </p>
                      ) : (
                        <>
                          <p className="computer-terminal-meta">
                            {typeof run.exitCode === 'number'
                              ? `Sortie ${run.exitCode}`
                              : 'Terminé'}
                            {typeof run.elapsedMs === 'number' &&
                              ` · ${(run.elapsedMs / 1000).toFixed(1)} s`}
                            {run.timedOut && ' · délai dépassé'}
                            {run.truncated && ' · sortie tronquée'}
                          </p>
                          {run.stdout && <pre>{run.stdout}</pre>}
                          {run.stderr && (
                            <pre className="computer-terminal-stderr">
                              {run.stderr}
                            </pre>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ol>
                {!terminal.runs.length && (
                  <p>Aucune commande pour l’instant.</p>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action('exec', { command, timeoutMs: 30000 });
                  }}
                >
                  <textarea
                    aria-label="Commande terminal"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    maxLength={8000}
                    rows={3}
                    disabled={!running || !status.permissions.shell || busy}
                    placeholder="pwd"
                  />
                  <button
                    disabled={
                      !running ||
                      !status.permissions.shell ||
                      busy ||
                      !command.trim()
                    }
                  >
                    Exécuter
                  </button>
                </form>
                {!status.permissions.shell && (
                  <p>
                    Activez la permission Terminal pour exécuter des commandes.
                  </p>
                )}
              </details>
            </>
          )}
          <details
            className="computer-section"
            open
            hidden={tab !== 'Activity'}
          >
            <summary>Activité récente</summary>
            {status.audit.length ? (
              <ol className="computer-audit">
                {status.audit
                  .slice(-30)
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.action.replaceAll('_', ' ')}</strong>
                      <span>
                        {entry.actor} · {entry.outcome} ·{' '}
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p>Aucune action pour l’instant.</p>
            )}
          </details>
          <details className="computer-settings">
            <summary>Réglages de l’ordinateur</summary>{' '}
            <details
              className="computer-permissions"
              open={!status.permissions.enabled}
            >
              <summary>Permissions de l’ordinateur</summary>
              <p>
                Choisissez ce à quoi {dot.name} et les contrôles peuvent
                accéder.
              </p>
              {(['enabled', 'browser', 'files', 'shell'] as const).map(
                (permission) => (
                  <label key={permission}>
                    <input
                      type="checkbox"
                      checked={status.permissions[permission]}
                      disabled={busy || !status.configured}
                      onChange={(event) =>
                        void run(
                          '/permissions',
                          { [permission]: event.target.checked },
                          'PATCH',
                        )
                      }
                    />
                    {
                      {
                        enabled: 'Activer cet ordinateur',
                        browser: 'Navigateur',
                        files: 'Fichiers',
                        shell: 'Terminal',
                      }[permission]
                    }
                  </label>
                ),
              )}
            </details>
            <div className="computer-actions">
              <button
                disabled={
                  busy ||
                  !status.configured ||
                  !status.permissions.enabled ||
                  status.state === 'running'
                }
                onClick={() => void run('/start')}
              >
                Démarrer
              </button>
              <button
                disabled={busy || status.state !== 'running'}
                onClick={() => void run('/stop')}
              >
                Arrêter
              </button>
            </div>
            <p className="computer-hint">
              L’arrêt conserve les fichiers du workspace. Les sessions
              navigateur peuvent demander de se reconnecter.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
