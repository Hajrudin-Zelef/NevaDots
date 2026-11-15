import { openPageLink } from './page-navigation';
import { SpaceNav } from './SpaceNav';
import { SpaceWorkspace } from './SpaceWorkspace';
import { useCallback, useEffect, useState, useRef } from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  ArrowUpRight,
  BookOpen,
  CircleHelp,
  CircleUserRound,
  Clock3,
  House,
  Info,
  LogOut,
  Mic,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Palette,
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
import { api, ApiError, sessionTransport } from './api';
import {
  logoutSession,
  refreshSessionStatus,
  useSessionStatus,
} from './session-model';
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
import type { ComputerPanelTab } from './ComputerPanel';
import { TaskRow } from './TaskPresentation';
import { TaskActions } from './TaskActions';
import { initialsOf } from './initials';
import { createSubmitGuard } from './submit-guard';
import { usePromptDraft } from './prompt-draft';
import { loadPromptHistory, pushPromptHistory } from './prompt-history';
import {
  conversationHash,
  isRestoreClosedTabKey,
  parseConversationHash,
  useTabs,
} from './useTabs';
import { WorkspaceDialog, type Dialog } from './WorkspaceDialog';
import {
  hasUnread,
  loadSeen,
  markSeen,
  saveSeen,
  type SeenMap,
} from './read-state';
import { readSidebarWidth } from './sidebar-width';

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
  // Onglets persistés (Lot 1) : l'onglet actif EST la conversation
  // sélectionnée — plus de `useState` séparé, sinon les deux divergent.
  const tabs = useTabs({
    validThreadIds: workspace?.conversations.map((item) => item.id),
    initialActiveThreadId: parseConversationHash(location.hash),
  });
  const selectedThread = tabs.activeThreadId;
  // Dernière valeur pour les écouteurs montés une fois (hashchange, clavier).
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  });
  const [view, rawSetView] = useState<'chat' | 'tasks' | 'memories' | 'space'>(
    'chat',
  );
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  const dirtyPage = useRef(false);
  const [spaceId, setSpaceId] = useState('');
  const [pageId, setPageId] = useState<string>();
  const setDirtyPage = useCallback((value: boolean) => {
    dirtyPage.current = value;
  }, []);
  // Retourne `false` si la navigation est annulée par la garde page-sale :
  // les appelants qui mutent les onglets doivent s'arrêter là — sinon
  // l'onglet bascule (et persiste) alors que la vue reste sur la page sale.
  // Un simple réordonnancement ne suffit pas : `setView` retournait `void`,
  // donc le code après l'appel continuait de tourner malgré l'annulation.
  const setView = (next: typeof view): boolean => {
    if (dirtyPage.current && !window.confirm('Leave your unsaved page draft?'))
      return false;
    dirtyPage.current = false;
    if (next !== 'space')
      history.replaceState(null, '', location.pathname + location.search);
    rawSetView(next);
    return true;
  };
  useEffect(() => {
    let acceptedHash = location.hash;
    const navigate = () => {
      const hash = location.hash;
      // Route conversation : activation d'onglet, sans la garde dirty-page
      // (les conversations n'ont pas de brouillon sale ; seuls les Spaces
      // en ont). La garde reste appliquée quand on QUITTE une page sale.
      const conversationId = parseConversationHash(hash);
      if (conversationId) {
        if (dirtyPage.current && hash === acceptedHash) return;
        if (
          dirtyPage.current &&
          !window.confirm('Leave your unsaved page draft?')
        ) {
          history.replaceState(null, '', acceptedHash || location.pathname);
          return;
        }
        acceptedHash = hash;
        dirtyPage.current = false;
        tabsRef.current.openTab(conversationId);
        rawSetView('chat');
        setMobile(false);
        return;
      }
      if (hash === '') {
        // Retour navigateur vers l'URL sans hash : page vierge, mais
        // seulement si on venait d'une route conversation en vue chat.
        if (
          acceptedHash.startsWith('#/conversations/') &&
          viewRef.current === 'chat'
        ) {
          acceptedHash = '';
          tabsRef.current.deactivate();
          rawSetView('chat');
          setMobile(false);
        }
        return;
      }
      const match = hash.match(/^#\/spaces\/([^/]+)(?:\/pages\/([^/]+))?$/);
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
  // Route <-> onglet : l'onglet actif s'écrit dans le hash (replaceState, pas
  // d'événement hashchange, pas d'entrée d'historique supplémentaire) ; les
  // autres vues ont déjà effacé le hash via `setView` / `openPage`.
  useEffect(() => {
    if (view !== 'chat') return;
    if (selectedThread) {
      const hash = conversationHash(selectedThread);
      if (location.hash !== hash) history.replaceState(null, '', hash);
    } else if (parseConversationHash(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [selectedThread, view]);
  // L'onglet actif peut appartenir à un autre Dot que celui sélectionné
  // (restauration après rechargement, ouverture depuis un Space) : le Dot
  // suit l'onglet, sinon `thread` est introuvable et l'écran reste vierge.
  useEffect(() => {
    if (!workspace || !selectedThread) return;
    const conversation = workspace.conversations.find(
      (item) => item.id === selectedThread,
    );
    if (conversation && conversation.dotId !== selectedDot)
      setSelectedDot(conversation.dotId);
  }, [workspace, selectedThread, selectedDot]);
  // mod+shift+t : rouvrir le dernier onglet fermé. (mod+t / mod+w restent
  // au navigateur : dans une app web, ils ne sont pas interceptables de
  // façon fiable — cf. analyse domaine 1, risque 9.)
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!isRestoreClosedTabKey(event)) return;
      event.preventDefault();
      tabsRef.current.restoreClosedTab();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
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
  const [dialog, setDialog] = useState<Dialog>();
  /** Phase F : menu avatar (Profil / Apparence / Paramètres / FAQ / À propos / Déconnexion). */
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  /** MVC-Statut (lots 1.3-1.4) : le statut de session vient du modèle —
   *  aucune lecture `/me` locale. `out` → la porte serveur + api.ts 401
   *  restent l'autorité réseau ; ici on ne fait que refléter. */
  const session = useSessionStatus();
  useEffect(() => {
    void refreshSessionStatus(sessionTransport);
  }, []);
  useEffect(() => {
    if (session.state === 'out') window.location.href = '/login';
  }, [session.state]);
  useEffect(() => {
    if (!profileMenuOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileMenuOpen(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [profileMenuOpen]);
  const [mobile, setMobile] = useState(false);
  // Sidebar (Lot 2) : bascule persistée (`mod+shift+b` + bouton flottant)
  // et largeur redimensionnable (240 px par défaut, 136–640, persistée).
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem('nevadots-sidebar-collapsed') === 'closed',
  );
  const navCollapsedRef = useRef(navCollapsed);
  useEffect(() => {
    navCollapsedRef.current = navCollapsed;
  });
  const changeNavCollapsed = useCallback((collapsed: boolean) => {
    setNavCollapsed(collapsed);
    try {
      localStorage.setItem(
        'nevadots-sidebar-collapsed',
        collapsed ? 'closed' : 'open',
      );
    } catch {
      // Appliqué pour cette visite seulement.
    }
  }, []);
  // Largeur lue depuis localStorage (240 px par défaut sur un profil
  // frais — voir `sidebar-width.ts` : la chaîne brute est testée d'abord,
  // `Number(null)` valant 0 donnait 136 px avant ce correctif).
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--nd-sidebar-w',
      `${sidebarWidth}px`,
    );
    try {
      localStorage.setItem('nevadots-sidebar-w', String(sidebarWidth));
    } catch {
      // Appliqué pour cette visite seulement.
    }
  }, [sidebarWidth]);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  // mod+shift+b : basculer la sidebar (Lot 2). Note : Chrome réserve
  // Ctrl+Maj+B à sa propre barre de favoris et peut avaler le raccourci —
  // le bouton flottant et le bouton de la topbar restent les chemins fiables.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault();
        changeNavCollapsed(!navCollapsedRef.current);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [changeNavCollapsed]);
  // État lu / non-lu des sessions (Lot 2) : local, voir `read-state.ts`.
  const [seen, setSeen] = useState<SeenMap>(loadSeen);
  useEffect(() => {
    saveSeen(seen);
  }, [seen]);
  // La conversation active est lue : une activité qui arrive pendant
  // qu'on la regarde ne la rend pas non-lue.
  useEffect(() => {
    if (!selectedThread || !workspace) return;
    const conversation = workspace.conversations.find(
      (item) => item.id === selectedThread,
    );
    if (!conversation) return;
    const last = conversation.updatedAt ?? conversation.createdAt;
    setSeen((current) =>
      (current[selectedThread] ?? 0) >= last
        ? current
        : markSeen(current, selectedThread),
    );
  }, [selectedThread, workspace]);
  // Dialogue de confirmation (français) — remplace `window.confirm`.
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirm(null);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [confirm]);
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
  const [computerInitialTab, setComputerInitialTab] =
    useState<ComputerPanelTab>('Browser');
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
  const openComputer = useCallback(() => {
    setComputerInitialTab('Browser');
    setPane(true);
  }, []);
  // Signal incrémental : force l'onglet Terminal même si le panneau est
  // déjà ouvert (le simple changement d'initialTab ne suffit pas quand la
  // valeur est déjà 'Terminal', ex. l'utilisateur lisait l'onglet Fichiers).
  const [computerTerminalSignal, setComputerTerminalSignal] = useState(0);
  const openComputerTerminal = useCallback(() => {
    setComputerInitialTab('Terminal');
    setComputerTerminalSignal((n) => n + 1);
    setPane(true);
  }, []);
  const [capture, setCapture] = useState<Result>();
  // Lot 5, étape 2 : brouillon persisté (`nevadots:draft:home:<dotId>`),
  // rechargé quand le Dot actif change.
  const {
    draft: prompt,
    draftRef: promptRef,
    setDraft: setPrompt,
    clearDraft: clearPrompt,
  } = usePromptDraft(`home:${selectedDot}`);
  const [promptSource, setPromptSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const attachments = useAttachments(`home:${selectedDot}`);
  const attachmentBar = useRef<AttachmentBarHandle>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [pendingVoice, setPendingVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  // Verrou anti-double-submit (H5) : pas un state (stale entre deux appels
  // rapprochés), même motif que Chat.tsx `sendingRef`.
  const startingGuard = useRef(createSubmitGuard());
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
      setSelectedDot((previous) => previous || w.dots[0]?.id || '');
      setNotices((current) => applyRefreshResult(current, { ok: true }));
    } catch (e) {
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
  // Comme le navigateur (qui ouvre le pane quand l'agent navigue) : à la
  // première commande exec du Dot, on ouvre le panneau sur l'onglet
  // Terminal. Le rail se replie derrière (invariant rail && !pane) et
  // réapparaît — avec son strip — à la fermeture du panneau.
  const onAgentTerminalStart = useCallback(() => {
    setComputerInitialTab('Terminal');
    setComputerTerminalSignal((n) => n + 1);
    setPane(true);
  }, []);
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
    // Garde page-sale D'ABORD : si l'utilisateur annule, rien ne bouge
    // (ni le Dot, ni l'onglet actif).
    if (!setView('chat')) return;
    setSelectedDot(next.id);
    const first = workspace?.conversations.find(
      (item) => item.dotId === next.id,
    );
    if (first) tabs.openTab(first.id);
    else tabs.deactivate();
    setMobile(false);
    setPendingPrompt(undefined);
    setPendingVoice(false);
  };
  const newConversation = async (text?: string): Promise<boolean> => {
    if (text === undefined) {
      // Garde page-sale D'ABORD : si l'utilisateur annule, la page vierge
      // n'est pas ouverte et l'onglet actif ne bouge pas.
      if (!setView('chat')) return false;
      tabs.deactivate();
      setPendingPrompt(undefined);
      setPendingVoice(false);
      clearPrompt();
      setPromptSource('');
      setSourceOpen(false);
      setComposerToolsOpen(false);
      setPane(false);
      setMobile(false);
      return true;
    }
    if (!dot || !configured || busy) return false;
    // H5 : `busy` est stale entre deux appels rapprochés et `prepareSend`
    // est async — le garde synchrone bloque le second appel.
    if (!startingGuard.current.tryAcquire()) return false;
    setBusy(true);
    setError('');
    try {
      const next = await api<Conversation>('/conversations', 'POST', {
        dotId: dot.id,
        title: text.trim().slice(0, 80) || 'Conversation vocale',
      });
      await refresh();
      tabs.openTab(next.id);
      setPendingPrompt(text.trim() ? text : undefined);
      setPendingVoice(text === '');
      clearPrompt();
      setPromptSource('');
      setSourceOpen(false);
      setComposerToolsOpen(false);
      setView('chat');
      setMobile(false);
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create the conversation.',
      );
      return false;
    } finally {
      setBusy(false);
      startingGuard.current.release();
    }
  };
  /** Envoi du composer d'accueil (Ctrl+Entrée ou Alt+Entrée : pas de
   *  tour en cours ici, les deux démarrent la conversation). L'historique
   *  n'est poussé qu'après création réussie ; en cas d'échec le brouillon
   *  est conservé tel quel. */
  const submitHomePrompt = () => {
    // Garde vide (revue finale, Important 2) : Alt+Entrée sur un brouillon
    // vide ne doit rien créer — sans elle, `prepareSend('')` → `''` →
    // `newConversation('')` créait une « Conversation vocale » avec
    // bascule voix. La garde est ici, pas dans `newConversation` : le
    // bouton voix appelle `newConversation('')` directement, et c'est
    // intentionnel. Seules les pièces jointes en attente autorisent un
    // brouillon vide (comme le bouton d'envoi).
    if (!promptRef.current.trim() && !attachments.items.length) return;
    void (async () => {
      try {
        const raw = promptRef.current;
        const attachmentNames = attachments.items.map((a) => a.name);
        const text = await attachments.prepareSend(raw);
        const ok = await newConversation(
          `${promptSource.trim() ? `From ${promptSource.trim()}:\n\n` : ''}${text}`,
        );
        if (ok && raw.trim()) {
          pushPromptHistory({
            prompt: raw,
            mode: 'home',
            ...(attachmentNames.length ? { attachments: attachmentNames } : {}),
          });
        }
      } catch {
        // prepareSend a déjà signalé l'échec (fichiers en erreur).
      }
    })();
  };
  // --- Historique des prompts (Lot 5, étape 5), même règle que Chat. ---
  const [homeHistoryIndex, setHomeHistoryIndex] = useState<number | null>(null);
  const homeHistoryBaseRef = useRef('');
  const homeHistoryPrev = () => {
    const entries = loadPromptHistory();
    if (!entries.length) return;
    if (homeHistoryIndex === null)
      homeHistoryBaseRef.current = promptRef.current;
    const next = Math.min((homeHistoryIndex ?? -1) + 1, entries.length - 1);
    setHomeHistoryIndex(next);
    setPrompt(entries[next].prompt);
  };
  const homeHistoryNext = () => {
    if (homeHistoryIndex === null) return;
    const entries = loadPromptHistory();
    const next = homeHistoryIndex - 1;
    if (next < 0) {
      setHomeHistoryIndex(null);
      setPrompt(homeHistoryBaseRef.current);
    } else {
      setHomeHistoryIndex(next);
      setPrompt(entries[next].prompt);
    }
  };
  const homeHistorySelect = (value: string) => {
    setHomeHistoryIndex(null);
    setPrompt(value);
  };
  const onPromptChange = (value: string) => {
    setHomeHistoryIndex(null);
    setPrompt(value);
  };
  /** Mod+. / Maj+Mod+. : cycle entre les Dots (chip agent, étape 4). */
  const cycleHomeDot = (direction: 1 | -1) => {
    const list = workspace?.dots ?? [];
    if (list.length < 2 || !dot) return;
    const index = list.findIndex((candidate) => candidate.id === dot.id);
    const next = list[(index + direction + list.length) % list.length];
    if (next && next.id !== dot.id) chooseDot(next);
  };
  const homeAgentChip =
    (workspace?.dots.length ?? 0) > 1 && dot ? (
      <button
        type="button"
        className="agent-chip"
        aria-label={`Agent actif : ${dot.name} — changer d'agent (Mod+.)`}
        title={`Agent : ${dot.name} — Mod+. pour changer`}
        onClick={() => cycleHomeDot(1)}
      >
        {dot.name}
      </button>
    ) : undefined;
  /** Renommage (Lot 2) : mise à jour optimiste (titre + `updatedAt` :
   * la conversation remonte en tête de liste), PATCH avec timeout 15 s,
   * puis `refresh()` ; en cas d'échec, `refresh()` restaure le titre et
   * `false` est résolu pour que la ligne reste en édition. */
  const renameConversation = async (
    id: string,
    title: string,
  ): Promise<boolean> => {
    if (!workspace?.conversations.some((item) => item.id === id)) return false;
    const now = Date.now();
    setWorkspace((current) =>
      current
        ? {
            ...current,
            conversations: current.conversations.map((conversation) =>
              conversation.id === id
                ? { ...conversation, title, updatedAt: now }
                : conversation,
            ),
          }
        : current,
    );
    try {
      await api<Conversation>(
        `/conversations/${id}`,
        'PATCH',
        { title },
        AbortSignal.timeout(15000),
      );
      await refresh();
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not rename the conversation.',
      );
      await refresh();
      return false;
    }
  };
  /** Export (Lot 2) : un fichier Markdown (titre, Dot, dates, activité
   * enregistrée) téléchargé localement. Sans transcript complet — celui-ci
   * demanderait un endpoint messages dédié (V2). */
  const exportConversation = (id: string) => {
    const conversation = workspace?.conversations.find(
      (item) => item.id === id,
    );
    if (!conversation || !workspace) return;
    const dotName =
      workspace.dots.find((dot) => dot.id === conversation.dotId)?.name ?? '';
    const download = (events: unknown) => {
      const lines = [
        `# ${conversation.title}`,
        '',
        `- Dot : ${dotName}`,
        `- Créée le ${new Date(conversation.createdAt).toLocaleString('fr-FR')}`,
        `- Dernière activité : ${new Date(conversation.updatedAt ?? conversation.createdAt).toLocaleString('fr-FR')}`,
        '',
        '## Activité',
        '',
      ];
      const list = Array.isArray(events) ? events : [];
      if (list.length === 0) lines.push('Aucune activité enregistrée.');
      else
        for (const event of list) {
          if (typeof event === 'object' && event !== null) {
            const record = event as Record<string, unknown>;
            const label =
              typeof record.label === 'string'
                ? record.label
                : typeof record.text === 'string'
                  ? record.text
                  : JSON.stringify(event);
            lines.push(`- ${label}`);
          } else lines.push(`- ${String(event)}`);
        }
      lines.push('');
      const slug =
        conversation.title
          .toLocaleLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || 'conversation';
      const url = URL.createObjectURL(
        new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${slug}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    };
    void api<{ events: unknown }>(`/conversations/${id}/activity`)
      .then(({ events }) => download(events))
      .catch(() => download(null));
  };
  const markConversationRead = (id: string) =>
    setSeen((current) => markSeen(current, id));
  const deleteConversation = (id: string) => {
    const conversation = workspace?.conversations.find(
      (item) => item.id === id,
    );
    setConfirm({
      title: 'Supprimer cette conversation ?',
      message: `« ${conversation?.title ?? 'Conversation'} » sera définitivement supprimée, avec son historique.`,
      confirmLabel: 'Supprimer',
      onConfirm: () => void performDeleteConversation(id),
    });
  };
  const performDeleteConversation = async (id: string) => {
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
    // La conversation supprimée n'est pas restaurable (mod+shift+t) :
    // son onglet est fermé sans passer par la pile des fermés.
    tabs.closeTab(id, { keepClosed: false });
    if (selectedThread === id) {
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
  const deleteAllConversations = () => {
    setConfirm({
      title: 'Supprimer toutes les conversations ?',
      message:
        'Toutes les conversations seront définitivement supprimées, avec leur historique.',
      confirmLabel: 'Tout supprimer',
      onConfirm: () => void performDeleteAllConversations(),
    });
  };
  const performDeleteAllConversations = async () => {
    setWorkspace((current) =>
      current ? { ...current, conversations: [] } : current,
    );
    tabs.closeAllTabs();
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
  if (session.state === 'unknown')
    return (
      <main className="unlock">
        <Mascot state="thinking" />
        <h1>Vérification de la session…</h1>
      </main>
    );
  if (!state || !workspace || !dot)
    return (
      <main className="unlock">
        <Mascot state="working" />
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
        {/* Lot 6, étape 1 : poignée du tiroir bas (≤ 767 px, 28×4 px ;
            masquée sur bureau par responsive.css). */}
        <div className="sidebar-sheet-handle" aria-hidden="true" />
        <div className="sidebar-brand">
          <button
            className="wordmark"
            onClick={() => {
              if (!setView('chat')) return;
              tabs.deactivate();
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
              openComputer();
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
              dots={workspace.dots}
              local={workspace.conversations}
              selected={view === 'chat' ? selectedThread : undefined}
              previewThreadId={tabs.previewThreadId}
              seen={seen}
              category={conversationCategory}
              search={conversationSearch}
              onSearchChange={setConversationSearch}
              onSelect={(id) => {
                // Garde page-sale D'ABORD : si l'utilisateur annule,
                // l'onglet actif ne bascule pas (et ne persiste pas).
                if (!setView('chat')) return;
                const conversation = workspace.conversations.find(
                  (item) => item.id === id,
                );
                if (conversation) setSelectedDot(conversation.dotId);
                // Clic = aperçu éphémère (Lot 2) ; double-clic = conserver.
                tabs.openTab(id, { preview: true });
                setPendingVoice(false);
                setMobile(false);
              }}
              onKeepPreview={(id) => tabs.keepPreview(id)}
              onRename={(id, title) => renameConversation(id, title)}
              onExport={(id) => exportConversation(id)}
              onMarkRead={(id) => markConversationRead(id)}
              onDelete={(id) => deleteConversation(id)}
            />
          ) : (
            <div className="sidebar-empty">
              Configurez le chat pour commencer une conversation.
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-profile">
            {/* Phase F : le menu avatar — seul chemin de déconnexion. */}
            <div className="profile-menu-wrap">
              <button
                className="profile-menu-button"
                aria-label="Menu du compte"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((open) => !open)}
              >
                <span className="sidebar-avatar">
                  {initialsOf(session.username ?? '')}
                </span>
              </button>
              {profileMenuOpen && (
                <>
                  <div
                    className="profile-menu-backdrop"
                    onClick={() => setProfileMenuOpen(false)}
                  />
                  <div className="profile-menu" role="menu">
                    <button
                      className="profile-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setDialog({ type: 'profile' });
                      }}
                    >
                      <CircleUserRound size={15} />
                      Profil
                    </button>
                    <button
                      className="profile-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setDialog({ type: 'settings', tab: 'appearance' });
                      }}
                    >
                      <Palette size={15} />
                      Apparence
                    </button>
                    <button
                      className="profile-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setDialog({ type: 'settings', tab: 'preferences' });
                      }}
                    >
                      <Settings2 size={15} />
                      Paramètres
                    </button>
                    <button
                      className="profile-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setDialog({ type: 'faq' });
                      }}
                    >
                      <CircleHelp size={15} />
                      FAQ
                    </button>
                    <button
                      className="profile-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setDialog({ type: 'settings', tab: 'about' });
                      }}
                    >
                      <Info size={15} />À propos
                    </button>
                    <div className="profile-menu-separator" />
                    <button
                      className="profile-menu-item profile-menu-logout"
                      role="menuitem"
                      onClick={async () => {
                        setProfileMenuOpen(false);
                        try {
                          // MVC-Statut (lot 1.4) : le modèle passe à `out`,
                          // le contrôleur redirige.
                          await logoutSession(sessionTransport);
                          window.location.href = '/login';
                        } catch (err) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : 'Could not log out.',
                          );
                        }
                      }}
                    >
                      <LogOut size={15} />
                      Déconnexion
                    </button>
                  </div>
                </>
              )}
            </div>
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
        {/* Lot 6, étape 1 : navigation basse du tiroir mobile (≤ 767 px ;
            masquée sur bureau par responsive.css). Actions à portée de
            pouce : nouvelle session, accueil, paramètres, aide — mêmes
            actions que la barre latérale (wordmark / profil / réglages /
            FAQ), le tiroir se referme après chaque choix. */}
        <nav className="sidebar-sheet-nav" aria-label="Navigation rapide">
          <button
            type="button"
            className="sidebar-sheet-nav-item sidebar-sheet-nav-new"
            disabled={!configured}
            onClick={() => {
              void newConversation();
              setMobile(false);
            }}
          >
            <Plus size={17} />
            <span>Nouvelle session</span>
          </button>
          <button
            type="button"
            className="sidebar-sheet-nav-item"
            onClick={() => {
              if (!setView('chat')) return;
              tabs.deactivate();
              setMobile(false);
            }}
          >
            <House size={17} />
            <span>Home</span>
          </button>
          <button
            type="button"
            className="sidebar-sheet-nav-item"
            onClick={() => {
              setDialog({ type: 'settings' });
              setMobile(false);
            }}
          >
            <Settings2 size={17} />
            <span>Paramètres</span>
          </button>
          <button
            type="button"
            className="sidebar-sheet-nav-item"
            onClick={() => {
              setDialog({ type: 'faq' });
              setMobile(false);
            }}
          >
            <CircleHelp size={17} />
            <span>Aide</span>
          </button>
        </nav>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner la barre latérale"
          onPointerDown={(event) => {
            resizeStart.current = { x: event.clientX, width: sidebarWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start) return;
            setSidebarWidth(
              Math.min(
                640,
                Math.max(136, start.width + (event.clientX - start.x)),
              ),
            );
          }}
          onPointerUp={() => {
            resizeStart.current = null;
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
          }}
        />
      </aside>
      {navCollapsed && (
        <button
          type="button"
          className="sidebar-float-button"
          aria-label={
            hasUnread(workspace.conversations, seen)
              ? 'Afficher la barre latérale (conversations non lues)'
              : 'Afficher la barre latérale'
          }
          title="Afficher la barre latérale (Ctrl+Maj+B)"
          onClick={() => changeNavCollapsed(false)}
        >
          <PanelLeft size={17} />
          {hasUnread(workspace.conversations, seen) && (
            <span className="sidebar-float-dot" aria-hidden="true" />
          )}
        </button>
      )}
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
                changeNavCollapsed(!navCollapsed);
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
                if (!setView('chat')) return;
                setSelectedDot(target.dotId);
                tabs.openTab(id);
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
                  onComputer={openComputer}
                  onAgentTerminalStart={onAgentTerminalStart}
                  onOpenTerminal={openComputerTerminal}
                  onSchedule={() =>
                    setDialog({ type: 'schedule', threadId: thread.id })
                  }
                  conversations={workspace.conversations}
                  tasks={state.tasks}
                  settings={state.settings}
                  onOpenConversation={(id) => {
                    setPane(false);
                    tabs.openTab(id);
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
                      ↑ 0 (entrée) · ↓ 0 (sortie) · ⇅ 0 en cache Tokens · Coût
                      estimé : $0,0000
                    </span>
                  </div>
                  <Composer
                    text={prompt}
                    onTextChange={onPromptChange}
                    placeholder={
                      configured
                        ? `Demander à ${dot.name}`
                        : 'Configurez un modèle pour commencer.'
                    }
                    inputDisabled={!configured}
                    inputAriaLabel="Démarrer une conversation"
                    canSubmitOnEnter={configured && !busy && !!prompt.trim()}
                    onSubmit={submitHomePrompt}
                    submitDisabled={
                      !configured ||
                      busy ||
                      attachments.uploading ||
                      (!prompt.trim() && !attachments.items.length)
                    }
                    submitTitle="Démarrer la conversation (Ctrl+Entrée)"
                    submitAriaLabel="Démarrer la conversation"
                    submitLabel="Démarrer"
                    hideSource
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
                        onComputer={openComputer}
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
                    dotId={dot.id}
                    modelValue={modelControls.modelValue}
                    modelOptions={modelControls.models}
                    defaultModelLabel={modelControls.defaultModelLabel}
                    onModelSaved={refresh}
                    onModelError={setError}
                    reasoningEffort={modelControls.reasoningEffort}
                    onSetReasoningEffort={(effort) =>
                      void modelControls.setReasoningEffort(effort)
                    }
                    reasoningLevels={modelControls.reasoningLevels}
                    reasoningMandatory={modelControls.reasoningMandatory}
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
                    agentChip={homeAgentChip}
                    historyEntries={loadPromptHistory()}
                    onHistorySelect={homeHistorySelect}
                    onHistoryPrev={homeHistoryPrev}
                    onHistoryNext={homeHistoryNext}
                    onQueueFront={submitHomePrompt}
                    onOpenAttachments={() =>
                      attachmentBar.current?.openFilesPicker()
                    }
                    onCycleDot={cycleHomeDot}
                    onToggleSourceShortcut={() =>
                      setSourceOpen((open) => !open)
                    }
                    onToggleMenuShortcut={() =>
                      setComposerToolsOpen((open) => !open)
                    }
                    onEscape={() => {
                      if (composerToolsOpen) setComposerToolsOpen(false);
                    }}
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
                initialComputerTab={computerInitialTab}
                focusTerminalSignal={computerTerminalSignal}
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
                    <button
                      type="button"
                      className="task-detail-close"
                      aria-label="Fermer"
                      onClick={() => setTaskDetail(undefined)}
                    >
                      <X size={18} />
                    </button>
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
              initialComputerTab={computerInitialTab}
              focusTerminalSignal={computerTerminalSignal}
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
      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div
            className="modal confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-dialog-title">{confirm.title}</h2>
            <p className="muted">{confirm.message}</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirm(null)}
              >
                Annuler
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const action = confirm.onConfirm;
                  setConfirm(null);
                  action();
                }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
  return configured ? (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      credentials="include"
      showDevConsole={false}
    >
      {content}
    </CopilotKitProvider>
  ) : (
    content
  );
}
