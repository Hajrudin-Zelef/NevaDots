import { openPageLink } from './page-navigation';
import { SpaceNav } from './SpaceNav';
import { SpaceWorkspace } from './SpaceWorkspace';
import { useCallback, useEffect, useState, useRef } from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  ArrowUpRight,
  BookOpen,
  Clock3,
  Mic,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Pause,
  PanelLeft,
  Play,
  Plus,
  Puzzle,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Conversation,
  Detail,
  Dot,
  Result,
  State,
  WorkspaceState,
} from '../shared/types';
import { api, ApiError, authHeaders, authToken, setToken } from './api';
import { trackSetupStep } from './setup-telemetry';
import {
  applyCaptureResult,
  applyRefreshResult,
  dismissNotice,
  visibleNotice,
  type Notices,
} from './poll-notice';
import { Mascot } from './Mascot';
import { Chat } from './Chat';
import { Composer } from './Composer';
import { ComposerMenu } from './ComposerMenu';
import { AttachmentBar, type AttachmentBarHandle } from './AttachmentBar';
import { useAttachments } from './useAttachments';
import { useDotModelControls } from './useDotModelControls';
import { ThreadList } from './ThreadList';
import { ResultPane } from './ResultPane';
import { TaskRow } from './TaskPresentation';
import { TaskActions } from './TaskActions';
import { WorkspaceDialog, type Dialog } from './WorkspaceDialog';

function describeFailure(error: unknown, fallback: string) {
  return {
    ok: false as const,
    status: error instanceof ApiError ? error.status : undefined,
    message: error instanceof Error ? error.message : fallback,
  };
}

interface SystemMetrics {
  cpu: number | null;
  mem: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  disk: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  netIn: number | null;
  netOut: number | null;
  uptime: number;
  model: string | null;
}

function useMetrics() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await api<SystemMetrics>('/metrics');
        if (active) setMetrics(value);
      } catch {
        /* metrics are best-effort */
      }
    };
    void load();
    // Only poll a visible tab: keeps the UI fluid and the box calm when hidden.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return metrics;
}

export function App() {
  const metrics = useMetrics();
  const [state, setState] = useState<State>();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const [selectedDot, setSelectedDot] = useState('');
  const [selectedThread, setSelectedThread] = useState<string>();
  const [view, rawSetView] = useState<'chat' | 'tasks' | 'memories' | 'space'>(
    'chat',
  );
  const dirtyPage = useRef(false);
  const [spaceId, setSpaceId] = useState('');
  const [pageId, setPageId] = useState<string>();
  const setDirtyPage = useCallback((value: boolean) => {
    dirtyPage.current = value;
  }, []);
  const setView = (next: typeof view) => {
    if (dirtyPage.current && !window.confirm('Leave your unsaved page draft?'))
      return;
    dirtyPage.current = false;
    if (next !== 'space')
      history.replaceState(null, '', location.pathname + location.search);
    rawSetView(next);
  };
  useEffect(() => {
    let acceptedHash = location.hash;
    const navigate = () => {
      const match = location.hash.match(
        /^#\/spaces\/([^/]+)(?:\/pages\/([^/]+))?$/,
      );
      if (!match) return;
      if (dirtyPage.current && location.hash === acceptedHash) return;
      if (
        dirtyPage.current &&
        !window.confirm('Leave your unsaved page draft?')
      ) {
        history.replaceState(null, '', acceptedHash || location.pathname);
        return;
      }
      acceptedHash = location.hash;
      dirtyPage.current = false;
      setSpaceId(match[1]);
      setPageId(match[2]);
      rawSetView('space');
      setMobile(false);
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const openPage = (space: string, page?: string) => {
    openPageLink(`#/spaces/${space}${page ? `/pages/${page}` : ''}`);
  };

  const [notices, setNotices] = useState<Notices>({
    refresh: '',
    capture: '',
    action: '',
  });
  const error = visibleNotice(notices);
  const setError = (action: string) =>
    setNotices((current) =>
      current.action === action ? current : { ...current, action },
    );
  const [auth, setAuth] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [mobile, setMobile] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  // Leaving the compact range must close the off-canvas drawer, otherwise the
  // scrim would linger over a docked layout.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 1024) setMobile(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [pane, setPane] = useState(false);
  // Muse-style activity rail: docked, open by default, persisted. It collapses
  // into the pop-pop avatar bubble while the browser pane is open.
  const [rail, setRail] = useState(
    () => localStorage.getItem('nevadots-rail') !== 'closed',
  );
  const railBeforePane = useRef(rail);
  useEffect(() => {
    if (pane) {
      railBeforePane.current = rail;
      setRail(false);
    } else {
      setRail(railBeforePane.current);
    }
  }, [pane]);
  const changeRail = useCallback((open: boolean) => {
    setRail(open);
    localStorage.setItem('nevadots-rail', open ? 'open' : 'closed');
  }, []);
  const [capture, setCapture] = useState<Result>();
  const [prompt, setPrompt] = useState('');
  const [promptSource, setPromptSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const attachments = useAttachments(`home:${selectedDot}`);
  const attachmentBar = useRef<AttachmentBarHandle>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [pendingVoice, setPendingVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [conversationSearch, setConversationSearch] = useState('');
  const [conversationCategory, setConversationCategory] = useState('all');
  const [taskDetail, setTaskDetail] = useState<Detail>();
  const refresh = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        api<State>('/state'),
        api<WorkspaceState>('/workspace'),
      ]);
      setState(s);
      setWorkspace(w);
      setNeedsAuth(false);
      setSelectedDot((previous) => previous || w.dots[0]?.id || '');
      setNotices((current) => applyRefreshResult(current, { ok: true }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
      setNotices((current) =>
        applyRefreshResult(
          current,
          describeFailure(e, 'Could not connect to the server.'),
        ),
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setCapture(undefined);
    if (!selectedThread) return;
    let active = true;
    const load = () =>
      void api<Result | null>(`/conversations/${selectedThread}/capture`)
        .then((result) => {
          if (!active) return;
          setCapture(result ?? undefined);
          setNotices((current) => applyCaptureResult(current, { ok: true }));
        })
        .catch((e) => {
          if (!active) return;
          setNotices((current) =>
            applyCaptureResult(
              current,
              describeFailure(e, 'Could not connect to the server.'),
            ),
          );
        });
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedThread]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    setError('');
    try {
      await api(path, method, body);
      await refresh();
      if (taskDetail)
        setTaskDetail(await api<Detail>(`/tasks/${taskDetail.task.id}`));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      return false;
    }
  };
  const dot =
    workspace?.dots.find((item) => item.id === selectedDot) ??
    workspace?.dots[0];
  // Modèles + raisonnement centralisés (hook partagé App/Chat).
  const modelControls = useDotModelControls({
    dotId: dot?.id ?? null,
    provider: dot?.provider,
    model: dot?.model,
    reasoningEffort: dot?.reasoningEffort,
    fallbackDefaultModel: metrics?.model ?? undefined,
    onReasoningStart: () => setError(''),
    onReasoningSaved: refresh,
    onReasoningError: setError,
  });
  const thread = workspace?.conversations.find(
    (item) => item.id === selectedThread && item.dotId === dot?.id,
  );
  const configured = !!workspace && workspace.setup.missing.length === 0;
  const setupStep = workspace
    ? dialog?.type === 'settings'
      ? 'settings'
      : configured
        ? 'ready'
        : 'setup_required'
    : undefined;
  useEffect(() => {
    if (!setupStep) return;
    return trackSetupStep(setupStep);
  }, [setupStep]);
  const chooseDot = (next: Dot) => {
    setSelectedDot(next.id);
    setSelectedThread(
      workspace?.conversations.find((item) => item.dotId === next.id)?.id,
    );
    setView('chat');
    setMobile(false);
    setPendingPrompt(undefined);
    setPendingVoice(false);
  };
  const newConversation = async (text?: string) => {
    if (text === undefined) {
      setSelectedThread(undefined);
      setPendingPrompt(undefined);
      setPendingVoice(false);
      setPrompt('');
      setPromptSource('');
      setSourceOpen(false);
      setPromptMenuOpen(false);
      setComposerToolsOpen(false);
      setView('chat');
      setPane(false);
      setMobile(false);
      return;
    }
    if (!dot || !configured || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Conversation>('/conversations', 'POST', {
        dotId: dot.id,
        title: text.trim().slice(0, 80) || 'Conversation vocale',
      });
      await refresh();
      setSelectedThread(next.id);
      setPendingPrompt(text.trim() ? text : undefined);
      setPendingVoice(text === '');
      setPrompt('');
      setPromptSource('');
      setSourceOpen(false);
      setPromptMenuOpen(false);
      setComposerToolsOpen(false);
      setView('chat');
      setMobile(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create the conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  const deleteConversation = async (id: string) => {
    if (!window.confirm('Delete this conversation? This cannot be undone.'))
      return;
    setWorkspace((current) =>
      current
        ? {
            ...current,
            conversations: current.conversations.filter(
              (conversation) => conversation.id !== id,
            ),
          }
        : current,
    );
    if (selectedThread === id) {
      setSelectedThread(undefined);
      setPendingPrompt(undefined);
    }
    try {
      await api(`/conversations/${id}`, 'DELETE');
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not delete the conversation.',
      );
      await refresh();
    }
  };
  const deleteAllConversations = async () => {
    if (!window.confirm('Delete ALL conversations? This cannot be undone.'))
      return;
    setWorkspace((current) =>
      current ? { ...current, conversations: [] } : current,
    );
    setSelectedThread(undefined);
    setPendingPrompt(undefined);
    try {
      await api('/conversations', 'DELETE');
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not delete the conversations.',
      );
      await refresh();
    }
  };
  if (needsAuth)
    return (
      <main className="unlock">
        {/* The Dot avatar is owner-private (gated on /dots), so the locked
            screen shows the public logo instead of the mascot. */}
        <img className="unlock-logo" src="/logo.png" alt="" />
        <h1>Your own little corner.</h1>
        <p>
          Enter the owner access token configured on this template’s server.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setToken(auth);
            try {
              await api('/state');
              setError('');
              await refresh();
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : 'Access token was not accepted.',
              );
            }
          }}
        >
          <input
            type="password"
            aria-label="Jeton d’accès propriétaire"
            autoComplete="current-password"
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
            required
          />
          <button className="primary">Unlock NevaDots</button>
        </form>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">The token stays in this tab’s session storage.</p>
      </main>
    );
  if (!state || !workspace || !dot)
    return (
      <main className="unlock">
        {authToken() ? (
          <Mascot state="working" />
        ) : (
          <img className="unlock-logo" src="/logo.png" alt="" />
        )}
        <h1>Finding your dots…</h1>
        {error && (
          <>
            <p className="chat-error">{error}</p>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        )}
      </main>
    );
  const content = (
    <div className={`app template-app ${navCollapsed ? 'nav-collapsed' : ''}`}>
      {mobile && (
        <button
          className="nav-scrim"
          aria-label="Fermer la navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? 'open' : ''}`}
      >
        <div className="sidebar-brand">
          <button
            className="wordmark"
            onClick={() => {
              setView('chat');
              setSelectedThread(undefined);
              setMobile(false);
            }}
          >
            <img
              className="wordmark-logo"
              src="/icon-256.png"
              alt=""
              width={25}
              height={25}
            />
            <span>NevaDots</span>
          </button>
          <span className="version-badge">v0.1.0</span>
          <span className="sidebar-credit">Assistant IA auto-hébergé</span>
        </div>
        <nav className="module-nav" aria-label="Modules">
          <button
            className={`module-button ${view === 'chat' && !pane ? 'active' : ''}`}
            onClick={() => {
              setView('chat');
              setPane(false);
              setMobile(false);
            }}
          >
            <MessageCircle size={15} />
            Agents
          </button>
          <button
            className={`module-button ${pane ? 'active' : ''}`}
            onClick={() => {
              setView('chat');
              setPane(true);
              setMobile(false);
            }}
          >
            <Monitor size={15} />
            Terminal
          </button>
          <button
            className="module-button"
            onClick={() => {
              setDialog({ type: 'settings' });
              setMobile(false);
            }}
          >
            <Puzzle size={15} />
            Plugins
          </button>
          <button
            className={`module-button ${view === 'memories' ? 'active' : ''}`}
            onClick={() => {
              setView('memories');
              setMobile(false);
            }}
          >
            <BookOpen size={15} />
            Compétences
          </button>
        </nav>
        <button
          className="new-chat-button"
          disabled={!configured}
          onClick={() => void newConversation()}
        >
          <Plus size={17} />
          Nouvelle conversation
        </button>
        <div className="conversation-filters">
          <label className="category-select-wrap">
            <span className="sr-only">Catégorie des conversations</span>
            <select
              value={conversationCategory}
              onChange={(event) => setConversationCategory(event.target.value)}
            >
              <option value="all">Toutes les catégories</option>
              {workspace.dots.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="Gérer les catégories et les paramètres"
            title="Paramètres"
            onClick={() => setDialog({ type: 'settings' })}
          >
            <Settings2 size={15} />
          </button>
        </div>
        <label className="conversation-search">
          <Search size={15} />
          <input
            aria-label="Rechercher une conversation"
            placeholder="Rechercher…"
            value={conversationSearch}
            onChange={(event) => setConversationSearch(event.target.value)}
          />
        </label>
        <div className="sidebar-list">
          <div className="spaces-heading nav-label">
            Dots
            <button
              className="icon-button"
              aria-label="Créer un Dot"
              onClick={() =>
                setDialog({ type: 'dot', spaceId: workspace.spaces[0].id })
              }
            >
              <Plus size={14} />
            </button>
          </div>
          <nav className="dots-nav" aria-label="Dots">
            {workspace.dots.map((item) => (
              <div className="dot-nav-row" key={item.id}>
                <button
                  className={`dot-nav ${dot.id === item.id && view === 'chat' ? 'active' : ''}`}
                  aria-current={
                    dot.id === item.id && view === 'chat' ? 'page' : undefined
                  }
                  onClick={() => chooseDot(item)}
                >
                  <Mascot
                    name={item.name}
                    avatar={item.avatar}
                    small
                    decorative
                  />
                  <span>{item.name}</span>
                </button>
                <button
                  className="icon-button dot-settings"
                  aria-label={`Modifier les paramètres de ${item.name}`}
                  onClick={() =>
                    setDialog({ type: 'dot', dot: item, spaceId: item.spaceId })
                  }
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
            ))}
          </nav>
          <div className="spaces-heading nav-label">
            Spaces
            <button
              className="icon-button"
              aria-label="Créer un Space"
              onClick={() => setDialog({ type: 'space' })}
            >
              <Plus size={14} />
            </button>
          </div>
          <nav className="spaces-nav" aria-label="Spaces">
            {workspace.spaces.map((space) => (
              <SpaceNav
                key={space.id}
                space={space}
                active={view === 'space' && spaceId === space.id}
                pageId={pageId}
                onOpen={(id) => openPage(space.id, id)}
              />
            ))}
          </nav>
          <button
            className={`nav-item sidebar-activity ${view === 'tasks' ? 'active' : ''}`}
            onClick={() => {
              setView('tasks');
              setMobile(false);
            }}
          >
            <Clock3 size={14} />
            <span>Activité</span>
            {state.tasks.length > 0 && <small>{state.tasks.length}</small>}
          </button>
          <div className="conversation-list-label">Conversations</div>
          {configured ? (
            <ThreadList
              dotId={dot.id}
              dots={workspace.dots}
              local={workspace.conversations}
              selected={view === 'chat' ? selectedThread : undefined}
              category={conversationCategory}
              search={conversationSearch}
              onSelect={(id) => {
                const conversation = workspace.conversations.find(
                  (item) => item.id === id,
                );
                if (conversation) setSelectedDot(conversation.dotId);
                setSelectedThread(id);
                setPendingVoice(false);
                setView('chat');
                setMobile(false);
              }}
              onDelete={(id) => void deleteConversation(id)}
            />
          ) : (
            <div className="sidebar-empty">
              Configurez le chat pour commencer une conversation.
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-profile">
            <span className="sidebar-avatar">AI</span>
            <span className="sidebar-profile-name">NevaDots</span>
            <button
              className="icon-button"
              aria-label={
                state.settings.paused
                  ? 'Reprendre les Dots'
                  : 'Mettre les Dots en pause'
              }
              title={
                state.settings.paused
                  ? 'Reprendre les Dots'
                  : 'Mettre les Dots en pause'
              }
              onClick={() =>
                void mutate('/settings', 'PATCH', {
                  paused: !state.settings.paused,
                })
              }
            >
              {state.settings.paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button
              className="icon-button"
              aria-label="Paramètres"
              title="Paramètres"
              onClick={() => setDialog({ type: 'settings' })}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="icon-button sidebar-delete-all"
              aria-label="Supprimer toutes les conversations"
              title="Supprimer toutes les conversations"
              disabled={!workspace.conversations.length}
              onClick={() => void deleteAllConversations()}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="desktop-nav-toggle document-icon"
            aria-label={
              mobile
                ? 'Fermer le panneau'
                : navCollapsed
                  ? 'Afficher le panneau'
                  : 'Masquer le panneau'
            }
            aria-expanded={mobile ? true : !navCollapsed}
            aria-controls="workspace-sidebar"
            onClick={() => {
              if (window.matchMedia('(max-width: 1024px)').matches) {
                setMobile(!mobile);
              } else {
                setNavCollapsed(!navCollapsed);
              }
            }}
          >
            {mobile ? <X size={17} /> : <PanelLeft size={17} />}
          </button>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Ignorer l’erreur"
              onClick={() => setNotices((current) => dismissNotice(current))}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {state.settings.paused && (
          <div className="notice">
            All Dots are paused. Active compute stops and scheduled tasks wait.
          </div>
        )}
        {view === 'space' ? (
          <SpaceWorkspace
            key={spaceId}
            space={
              workspace.spaces.find((s) => s.id === spaceId) ??
              workspace.spaces[0]
            }
            pageId={pageId}
            workspace={workspace}
            paused={state.settings.paused}
            onPage={(id) => openPage(spaceId, id)}
            onSettings={() => setDialog({ type: 'settings' })}
            onCreateDot={() => setDialog({ type: 'dot', spaceId })}
            onDirty={setDirtyPage}
            onRefresh={refresh}
            onSchedule={(threadId) => setDialog({ type: 'schedule', threadId })}
            onThread={(id) => {
              const target = workspace.conversations.find((t) => t.id === id);
              if (target) {
                setView('chat');
                setSelectedDot(target.dotId);
                setSelectedThread(id);
                setPendingVoice(false);
              }
            }}
          />
        ) : view === 'chat' ? (
          <div
            className={`chat-workspace ${pane ? 'split' : ''} ${rail && !pane ? 'rail' : ''}`}
          >
            <div className="chat-column">
              {thread && configured ? (
                <Chat
                  key={thread.id}
                  thread={thread}
                  dot={dot}
                  dots={workspace.dots}
                  memories={state.memories}
                  onChooseDot={chooseDot}
                  onCreateDot={() =>
                    setDialog({ type: 'dot', spaceId: dot.spaceId })
                  }
                  initialPrompt={pendingPrompt}
                  onConsumed={() => setPendingPrompt(undefined)}
                  startVoice={pendingVoice}
                  onVoiceRequestHandled={() => setPendingVoice(false)}
                  voiceReady={workspace.setup.voice}
                  calls={workspace.calls.filter(
                    (call) => call.threadId === thread.id,
                  )}
                  paused={state.settings.paused}
                  onSaved={refresh}
                  onComputer={() => setPane(true)}
                  onSchedule={() =>
                    setDialog({ type: 'schedule', threadId: thread.id })
                  }
                  conversations={workspace.conversations}
                  tasks={state.tasks}
                  settings={state.settings}
                  onOpenConversation={(id) => {
                    setPane(false);
                    setSelectedThread(id);
                  }}
                  onOpenSettings={() => setDialog({ type: 'settings' })}
                  onOpenTasks={() => setView('tasks')}
                  paneOpen={pane}
                  onClosePane={() => setPane(false)}
                  railOpen={rail && !pane}
                  onRailChange={changeRail}
                />
              ) : (
                <div className="new-conversation">
                  <div className="chat-transcript">
                    <div className="welcome-hero">
                      <Mascot
                        avatar={dot.avatar}
                        name={dot.name}
                        state={busy ? 'thinking' : 'idle'}
                      />
                      <span className="welcome-halo" aria-hidden="true" />
                      <h1>Par où commencer ?</h1>
                    </div>
                    {!configured && (
                      <div className="setup-card">
                        <span className="setup-icon">
                          <Settings2 size={20} />
                        </span>
                        <div>
                          <strong>Configurez votre Dot</strong>
                          <p>
                            Connectez un modèle et le service de conversation
                            dans les paramètres pour commencer. Vos Spaces et
                            vos Dots restent disponibles.
                          </p>
                          <button
                            className="text-button"
                            onClick={() => setDialog({ type: 'settings' })}
                          >
                            Ouvrir les paramètres <ArrowUpRight size={12} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="chat-token-bar">
                    <Mascot
                      name={dot.name}
                      avatar={dot.avatar}
                      small
                      animate
                      decorative
                      state={busy ? 'thinking' : 'idle'}
                    />
                    <span className="chat-token-info">
                      ↑ 0 (entrée) · ↓ 0 (sortie) Tokens · Coût estimé : $0,0000
                    </span>
                  </div>
                  <Composer
                    text={prompt}
                    onTextChange={setPrompt}
                    placeholder={
                      configured
                        ? `Demander à ${dot.name}`
                        : 'Configurez un modèle pour commencer.'
                    }
                    inputDisabled={!configured}
                    inputAriaLabel="Démarrer une conversation"
                    canSubmitOnEnter={configured && !busy && !!prompt.trim()}
                    onSubmit={() => {
                      void (async () => {
                        try {
                          const text = await attachments.prepareSend(prompt);
                          await newConversation(
                            `${promptSource.trim() ? `From ${promptSource.trim()}:\n\n` : ''}${text}`,
                          );
                        } catch {
                          // prepareSend a déjà signalé l'échec (fichiers en erreur).
                        }
                      })();
                    }}
                    submitDisabled={
                      !configured ||
                      busy ||
                      attachments.uploading ||
                      (!prompt.trim() && !attachments.items.length)
                    }
                    submitTitle="Démarrer la conversation"
                    submitAriaLabel="Démarrer la conversation"
                    sourceOpen={sourceOpen}
                    onToggleSource={() => setSourceOpen((open) => !open)}
                    source={promptSource}
                    onSourceChange={setPromptSource}
                    menuOpen={composerToolsOpen}
                    onToggleMenu={() => setComposerToolsOpen((open) => !open)}
                    menu={
                      <ComposerMenu
                        dots={workspace.dots}
                        activeDotId={dot.id}
                        memories={state.memories}
                        onSource={() => setSourceOpen(true)}
                        onChooseDot={chooseDot}
                        onInsertMemory={(text) =>
                          setPrompt((current) =>
                            current ? `${text}\n\n${current}` : text,
                          )
                        }
                        onComputer={() => setPane(true)}
                        onCreateDot={() =>
                          setDialog({ type: 'dot', spaceId: dot.spaceId })
                        }
                        onAddFiles={() =>
                          attachmentBar.current?.openFilesPicker()
                        }
                        onAddFolder={() =>
                          attachmentBar.current?.openFolderPicker()
                        }
                        onClose={() => setComposerToolsOpen(false)}
                        contextBudget={dot.contextBudget ?? null}
                        onContextBudget={async (budget) => {
                          await api(`/dots/${dot.id}/context-budget`, 'PUT', {
                            budget,
                          });
                          await refresh();
                        }}
                        compactionStrategy={dot.compactionStrategy ?? 'native'}
                        onCompactionStrategy={async (strategy) => {
                          await api(
                            `/dots/${dot.id}/compaction-strategy`,
                            'PUT',
                            { strategy },
                          );
                          await refresh();
                        }}
                      />
                    }
                    promptMenuOpen={promptMenuOpen}
                    onTogglePromptMenu={() => {
                      setComposerToolsOpen(false);
                      setPromptMenuOpen((open) => !open);
                    }}
                    promptMenu={
                      <div className="welcome-prompt-menu">
                        {[
                          'Aide-moi à réfléchir à cette idée',
                          'Fais une recherche sur cette page',
                          'Propose-moi un plan d’action',
                        ].map((suggestion) => (
                          <button
                            type="button"
                            key={suggestion}
                            onClick={() => {
                              setPrompt(suggestion);
                              setPromptMenuOpen(false);
                            }}
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    }
                    dotId={dot.id}
                    modelValue={modelControls.modelValue}
                    modelOptions={modelControls.models}
                    defaultModelLabel={modelControls.defaultModelLabel}
                    onModelSaved={refresh}
                    onModelError={setError}
                    reasoningEffort={modelControls.reasoningEffort}
                    reasoningLabel={modelControls.reasoningLabel}
                    onCycleReasoning={modelControls.cycleReasoning}
                    reasoningDisabled={modelControls.reasoningBusy}
                    voiceButton={
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Démarrer une conversation vocale"
                        title={
                          workspace.setup.voice
                            ? 'Démarrer une conversation vocale'
                            : 'La voix nécessite une configuration serveur'
                        }
                        disabled={!configured || !workspace.setup.voice || busy}
                        onClick={() => void newConversation('')}
                      >
                        <Mic size={17} />
                      </button>
                    }
                    note={
                      <>
                        {dot.name} ·{' '}
                        {modelControls.selectedModelLabel || 'Modèle'}
                      </>
                    }
                    attachmentCards={
                      <AttachmentBar
                        ref={attachmentBar}
                        attachments={attachments}
                      />
                    }
                  />
                </div>
              )}
            </div>
            {pane && (
              <ResultPane
                key={dot.id}
                dots={workspace.dots}
                defaultDotId={dot.id}
                latest={capture}
                dotState="idle"
                onClose={() => setPane(false)}
              />
            )}
          </div>
        ) : (
          <main className="main-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h1>
                  {view === 'memories'
                    ? 'Memories'
                    : 'A little follow-through.'}
                </h1>
                <p>
                  {view === 'memories'
                    ? 'Preferences you choose to share with your Dots.'
                    : 'Scheduled turns run on the server in their original conversation.'}
                </p>
              </div>
              {view === 'memories' && (
                <button
                  className="primary"
                  onClick={() => setDialog({ type: 'memory' })}
                >
                  <Plus size={15} />
                  Add memory
                </button>
              )}
            </div>
            {view === 'memories' ? (
              <>
                <div className="memory-grid">
                  {state.memories.map((memory) => (
                    <article className="memory-card" key={memory.id}>
                      <BookOpen size={18} />
                      <p>{memory.text}</p>
                      <div>
                        <small>
                          {state.settings.memoryAllowed
                            ? 'Available to permitted Dots'
                            : 'Memory use disabled'}
                        </small>
                        <button
                          className="icon-button"
                          aria-label="Modifier la mémoire"
                          onClick={() => setDialog({ type: 'memory', memory })}
                        >
                          <MoreHorizontal size={17} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Supprimer la mémoire"
                          onClick={() =>
                            void mutate(`/memories/${memory.id}`, 'DELETE', {})
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {!state.memories.length && (
                  <div className="large-empty">
                    <Mascot />
                    <h2>A little context goes a long way.</h2>
                    <p>
                      Add a preference like “Keep my research briefs short.” You
                      can change or remove it anytime.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Rechercher une tâche"
                    placeholder="Trouver une tâche…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="task-list">
                  {state.tasks
                    .filter((task) =>
                      task.prompt.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onClick={() =>
                          void api<Detail>(`/tasks/${task.id}`)
                            .then(setTaskDetail)
                            .catch((e) => setError(e.message))
                        }
                      />
                    ))}
                </div>
                {!state.tasks.length && (
                  <div className="large-empty">
                    <Clock3 size={32} />
                    <h2>Let a thought come back around.</h2>
                    <p>
                      Open a conversation and use the clock button to schedule a
                      server-side task.
                    </p>
                  </div>
                )}
                {taskDetail && (
                  <section className="task-detail-card">
                    <h2>{taskDetail.task.prompt}</h2>
                    <TaskActions
                      task={taskDetail.task}
                      busy={busy}
                      settings={state.settings}
                      onAction={(action) =>
                        void mutate(
                          `/tasks/${taskDetail.task.id}/actions`,
                          'POST',
                          { action },
                        )
                      }
                      onSchedule={async () => {
                        const raw = window.prompt(
                          'Repeat interval in minutes (0 removes the schedule)',
                          String((taskDetail.task.intervalSeconds ?? 0) / 60),
                        );
                        if (raw === null) return;
                        const value = Number(raw);
                        if (!Number.isFinite(value) || value < 0) {
                          setError('Enter a valid number of minutes.');
                          return;
                        }
                        await mutate(
                          `/tasks/${taskDetail.task.id}/schedule`,
                          'PUT',
                          {
                            intervalSeconds: value
                              ? Math.round(value * 60)
                              : null,
                          },
                        );
                      }}
                    />
                    {taskDetail.task.error && (
                      <p className="chat-error">{taskDetail.task.error}</p>
                    )}
                    {taskDetail.events.slice(-6).map((event) => (
                      <p className="muted" key={event.id}>
                        {event.text}
                      </p>
                    ))}
                    <small>{taskDetail.runs.length} saved runs</small>
                  </section>
                )}
              </>
            )}
          </main>
        )}
        {pane && view !== 'chat' && (
          <div className="computer-overlay">
            <ResultPane
              key={view === 'space' ? spaceId : dot.id}
              dots={workspace.dots}
              defaultDotId={
                view === 'space'
                  ? (workspace.dots.find((candidate) =>
                      candidate.spaceIds.includes(spaceId),
                    )?.id ?? dot.id)
                  : dot.id
              }
              dotState="idle"
              onClose={() => setPane(false)}
            />
          </div>
        )}
      </div>
      {dialog && (
        <WorkspaceDialog
          dialog={dialog}
          state={state}
          workspace={workspace}
          onClose={() => setDialog(undefined)}
          onOpenDialog={setDialog}
          mutate={mutate}
        />
      )}
    </div>
  );
  return configured ? (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      headers={authHeaders()}
      showDevConsole={false}
    >
      {content}
    </CopilotKitProvider>
  ) : (
    content
  );
}
