import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import {
  connectionActionSchema,
  connectionActionTool,
} from '../shared/connection-types';
import { ConnectionActionCard } from './ConnectionActionCard';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  ArrowDown,
  Bell,
  BellOff,
  FilePlus,
  Clock3,
  Maximize2,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ChatTranscript,
  isInternalVoiceReceipt,
  UserMessageContent,
} from './ChatTranscript';
import { ReasoningPanel } from './ReasoningPanel';
import { ActivityPanel } from './ActivityPanel';
import { ActivityTab } from './ActivityTab';
import { InterventionStage } from './InterventionStage';
import {
  pushRunFrame,
  useRunActivity,
  useRunMascotState,
} from './run-status-model';
import type { ReasoningRunStats } from '../server/reasoning.js';
import type {
  CallReceipt,
  Conversation,
  Dot,
  Memory,
  Settings,
  Task,
} from '../shared/types';
import { Mascot } from './Mascot';
import { Composer } from './Composer';
import { stopAllSpeech } from './MessageActions';
import { AttachmentBar, type AttachmentBarHandle } from './AttachmentBar';
import { useAttachments } from './useAttachments';
import {
  useAgentSteps,
  stepsFromTranscriptMessage,
  type AgentStep,
} from './useAgentSteps';
import {
  distanceToEnd,
  hasOverflow,
  HOLD_DETACH_MS,
  HOLD_MOVE_TOLERANCE_PX,
  nextFollowState,
  type FollowState,
} from './auto-scroll';
import { deriveTurnStatus, TURN_STATUS_LABELS } from './turn-status';
import { panelsMayAutoOpen } from './viewport';
import { fetchResponseStatsForMessage } from './response-stats';
import { useDotModelControls } from './useDotModelControls';
import { StepCard } from './StepCard';
import { ComposerMenu } from './ComposerMenu';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { useComputerActivity } from './useComputerActivity';
import { usePromptDraft } from './prompt-draft';
import {
  loadPromptHistory,
  pushPromptHistory,
  removePromptHistoryEntry,
  type PromptHistoryEntry,
} from './prompt-history';
import {
  dequeueQueued,
  enqueueQueued,
  enqueueQueuedFront,
  removeQueued,
  type QueuedMessage,
} from './chat-composer';

export function Chat({
  thread,
  dot,
  dots,
  memories,
  onChooseDot,
  onCreateDot,
  initialPrompt,
  onConsumed,
  startVoice,
  onVoiceRequestHandled,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
  onAgentTerminalStart,
  onOpenTerminal,
  conversations,
  tasks,
  settings,
  onOpenConversation,
  onOpenSettings,
  onOpenTasks,
  onClosePane,
  railOpen,
  onRailChange,
}: {
  thread: Conversation;
  dot: Dot;
  dots?: Dot[];
  memories?: Memory[];
  onChooseDot?: (dot: Dot) => void;
  onCreateDot?: () => void;
  initialPrompt?: string;
  onConsumed: () => void;
  startVoice?: boolean;
  onVoiceRequestHandled?: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
  onAgentTerminalStart?: () => void;
  onOpenTerminal?: () => void;
  conversations?: Conversation[];
  tasks?: Task[];
  settings?: Settings;
  onOpenConversation?: (id: string) => void;
  onOpenSettings?: () => void;
  onOpenTasks?: () => void;
  paneOpen?: boolean;
  onClosePane?: () => void;
  railOpen: boolean;
  onRailChange: (open: boolean) => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  // Le rail garde le flux actif pendant toute la conversation. Si le panneau
  // Terminal s'ouvre, son hook rejoint le même flux partagé au lieu d'en créer
  // un second.
  const terminalActivity = useComputerActivity(
    dot.id,
    true,
    onAgentTerminalStart,
  );
  const { copilotkit } = useCopilotKit();
  const runError = useRef('');
  // Phase 3 : carte de progression des étapes de l'agent.
  const { steps, history, resetSteps } = useAgentSteps(agent);
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  // Lot 5, étape 2 : brouillon persisté (`nevadots:draft:thread:<id>`),
  // chargé au montage, sauvé à chaque frappe, vidé après envoi réussi.
  const { draft, draftRef, setDraft, clearDraft, restoreDraft } =
    usePromptDraft(`thread:${thread.id}`);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Citation structurée (Lot 5, étape 6) : carte au-dessus du textarea,
   *  avec son champ commentaire — remplace le préfixe `> citation`. */
  const [quote, setQuote] = useState<{ text: string; comment: string } | null>(
    null,
  );
  /** Miroir synchrone de `quote` : les fermetures async (`runPrompt`,
   *  échec du tour) doivent lire la carte *courante*, pas la valeur
   *  capturée à l'envoi — sinon la restauration ne peut jamais se
   *  déclencher et une carte fraîche serait écrasée. */
  const quoteRef = useRef<{ text: string; comment: string } | null>(null);
  quoteRef.current = quote;
  /** Cite une sélection (« Répondre ») comme contexte du prochain message. */
  const quoteSelection = (text: string) => {
    setQuote({ text, comment: '' });
    composerInputRef.current?.focus();
  };
  // Lot 5, étape 3 : file en objets `{ id, text }` (même ordre, même
  // sémantique d'envoi — l'id stable permet ✕ / chargement en éditeur).
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  /** Chargement d'un message en file dans l'éditeur (Échap annule).
   *  L'élément entier est conservé (pas seulement `id`/`text`) pour que
   *  l'annulation remette en file le message avec son snapshot
   *  (`historyPrompt`, pièces jointes, citation) intact. */
  const [editingQueued, setEditingQueued] = useState<{
    item: QueuedMessage;
    previousDraft: string;
  } | null>(null);
  const loadQueued = (item: QueuedMessage) => {
    setEditingQueued({
      item,
      previousDraft: draftRef.current,
    });
    setQueued((current) => removeQueued(current, item.id));
    setDraft(item.text);
    composerInputRef.current?.focus();
  };
  const cancelQueuedEdit = (): boolean => {
    if (!editingQueued) return false;
    const { item, previousDraft } = editingQueued;
    setEditingQueued(null);
    setDraft(previousDraft);
    setQueued((current) => [item, ...current]);
    return true;
  };
  const attachments = useAttachments(`thread:${thread.id}`);
  const attachmentBar = useRef<AttachmentBarHandle>(null);
  const [stageOpen, setStageOpen] = useState(false);
  const [notify, setNotify] = useState(
    () =>
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('nevadots-notify') === '1',
  );
  const toggleNotify = async () => {
    if (notify) {
      setNotify(false);
      localStorage.setItem('nevadots-notify', '0');
      return;
    }
    if (typeof Notification === 'undefined') {
      setError('Les notifications ne sont pas disponibles dans ce navigateur.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setNotify(true);
      localStorage.setItem('nevadots-notify', '1');
    } else {
      setError('Notifications refusées par le navigateur.');
    }
  };
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  /** Globe du composer : recherche web classique (hors computer), par Dot.
   *  Effectif au tour suivant (outils retirés du schéma serveur). */
  const [webSearch, setWebSearch] = useState(dot.researchAllowed);
  useEffect(() => {
    setWebSearch(dot.researchAllowed);
  }, [dot.id, dot.researchAllowed]);
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const [error, setError] = useState('');
  const toggleWebSearch = async () => {
    const next = !webSearch;
    setWebSearch(next);
    try {
      await api(`/dots/${dot.id}/research`, 'PUT', { allowed: next });
      onSaved();
    } catch (cause) {
      setWebSearch(!next);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Recherche web non enregistrée.',
      );
    }
  };
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const prevRunForNotify = useRef(false);
  useEffect(() => {
    if (
      prevRunForNotify.current &&
      !running &&
      notify &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      document.hidden
    ) {
      const last = [...agent.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            typeof message.content === 'string' &&
            message.content.trim(),
        );
      const body = last
        ? String(last.content)
            .replace(/[#*`>_]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
        : 'Votre réponse est prête.';
      try {
        new Notification(`${dot.name} · réponse prête`, {
          body,
          tag: 'nevadots-turn',
        });
      } catch {
        /* notifications are best-effort */
      }
    }
    prevRunForNotify.current = running;
  }, [running, notify, dot.name, agent.messages]);
  // --- Reasoning panel ------------------------------------------------------
  // Opens automatically only when the provider actually streams reasoning.
  // Auto-collapses when the run finishes; the "Raisonnement" button on each
  // assistant response re-opens it manually.
  const [reasonPanel, setReasonPanel] = useState<{
    id: string;
    live: boolean;
  } | null>(null);
  const [reasonStats, setReasonStats] = useState<ReasoningRunStats | null>(
    null,
  );
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState('');
  const [showTranslation, setShowTranslation] = useState(false);
  const seenReasoning = useRef(new Set<string>());
  const prevRunning = useRef(false);
  // Verrou anti-double-submit : un ref (pas un state) pour que deux Entrée
  // rapprochés ne puissent pas lancer deux prepareSend+send concurrents.
  const sendingRef = useRef(false);
  // Transient mascot reactions fired when a run ends (success or failure).
  const [flash, setFlash] = useState<'' | 'complete' | 'error'>('');
  const prevRunForMascot = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunForMascot.current;
    prevRunForMascot.current = running;
    if (wasRunning && !running) {
      const kind = error ? 'error' : 'complete';
      setFlash(kind);
      const timer = setTimeout(
        () => setFlash(''),
        kind === 'error' ? 1500 : 1200,
      );
      return () => clearTimeout(timer);
    }
  }, [running, error]);
  const reasoningMessages = agent.messages.filter(
    (message) =>
      message.role === 'reasoning' &&
      typeof message.content === 'string' &&
      message.content.length > 0,
  );
  useEffect(() => {
    for (const message of reasoningMessages) {
      if (seenReasoning.current.has(message.id)) continue;
      seenReasoning.current.add(message.id);
      // Mobile : ouverture manuelle uniquement — le panneau est plein
      // écran, l'ouvrir tout seul recouvre la réponse en cours. Le texte
      // reste accessible par la carte de raisonnement du message.
      if (!panelsMayAutoOpen()) break;
      setReasonPanel({ id: message.id, live: true });
      break;
    }
  }, [reasoningMessages]);
  useEffect(() => {
    if (prevRunning.current && !running) {
      // The run just finished: reasoning stats are final on the server now.
      // Refresh them — the panel fetched too early, while the run was live.
      // (Auto-opened panels collapse right after; manually reopened ones
      // stay open and need the final numbers.)
      if (reasonPanel) {
        void api<ReasoningRunStats>(
          `/reasoning-stats?messageId=${encodeURIComponent(reasonPanel.id)}`,
        )
          .then((stats) => setReasonStats(stats?.model ? stats : null))
          .catch(() => {
            // Stats are best-effort; the reasoning text is what matters.
          });
      }
      if (reasonPanel?.live) {
        setReasonPanel(null);
      }
    }
    prevRunning.current = running;
  }, [running, reasonPanel]);
  useEffect(() => {
    setReasonStats(null);
    setTranslation(null);
    setTranslateError('');
    setShowTranslation(false);
    if (!reasonPanel) return;
    let cancelled = false;
    void api<ReasoningRunStats>(
      `/reasoning-stats?messageId=${encodeURIComponent(reasonPanel.id)}`,
    )
      .then((stats) => {
        if (!cancelled) setReasonStats(stats?.model ? stats : null);
      })
      .catch(() => {
        // Stats are best-effort; the reasoning text is what matters.
      });
    return () => {
      cancelled = true;
    };
  }, [reasonPanel?.id]);
  const reasonPanelText =
    (agent.messages.find((message) => message.id === reasonPanel?.id)
      ?.content as string | undefined) ?? '';
  const openReasoning = (reasoningId: string) =>
    setReasonPanel({ id: reasoningId, live: false });
  const translateReasoning = () => {
    if (translating || !reasonPanelText.trim()) return;
    setTranslating(true);
    setTranslateError('');
    // Fetch the DeepThink Global language first; the server falls back to
    // its persisted setting when targetLang is omitted.
    void api<{ settings: { lang: string } }>('/deepthink')
      .catch(() => ({ settings: { lang: 'fr' } }))
      .then(({ settings }) =>
        api<{ translation: string }>('/translate', 'POST', {
          text: reasonPanelText.slice(0, 12000),
          targetLang: settings.lang,
        }),
      )
      .then((result) => {
        setTranslation(result.translation);
        setShowTranslation(true);
      })
      .catch((e) => {
        setTranslateError(
          e instanceof Error ? e.message : 'La traduction a échoué.',
        );
      })
      .finally(() => setTranslating(false));
  };
  /** Closest reasoning block before an assistant message (same turn only). */
  const reasoningForMessage = useCallback(
    (message: { id: string }): string | undefined => {
      const index = agent.messages.findIndex((m) => m.id === message.id);
      if (index < 0) return undefined;
      for (let i = index - 1; i >= 0; i--) {
        const candidate = agent.messages[i];
        if (candidate.role === 'user') break;
        if (
          candidate.role === 'reasoning' &&
          typeof candidate.content === 'string' &&
          candidate.content.trim()
        ) {
          return candidate.id;
        }
      }
      return undefined;
    },
    [agent.messages],
  );
  // --- End reasoning panel ----------------------------------------------------
  const [modelError, setModelError] = useState('');
  // Modèles + raisonnement centralisés (hook partagé App/Chat).
  const modelControls = useDotModelControls({
    dotId: dot.id,
    provider: dot.provider,
    model: dot.model,
    reasoningEffort: dot.reasoningEffort,
    onReasoningStart: () => setModelError(''),
    onReasoningSaved: onSaved,
    onReasoningError: setModelError,
  });
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const voiceRequestStarted = useRef(false);
  useEffect(() => {
    if (
      !startVoice ||
      !voiceReady ||
      !loaded ||
      !contextReady ||
      paused ||
      voiceRequestStarted.current
    )
      return;
    voiceRequestStarted.current = true;
    onVoiceRequestHandled?.();
    void voice.start();
  }, [
    startVoice,
    voiceReady,
    loaded,
    contextReady,
    paused,
    voice.start,
    onVoiceRequestHandled,
  ]);
  const sent = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  // --- Auto-scroll à 4 états (lot 3, `auto-scroll.ts`) -------------------
  // `following` (défaut, on démarre en bas) / `detached` (lecteur remonté,
  // rien ne le ramène de force) / `returning` (reprise à la frame suivante,
  // avec id de tentative anti-obsolescence) / `anchored` (à moins de 4 px
  // de la fin : écart de zoom, la vue reste épinglée). Constantes 0,5 / 4 px.
  // Supprimés avec l'ancien booléen : le seuil de 48 px, le throttle
  // 150 ms, le saut forcé en bas à chaque fin de run et à chaque nouveau
  // message — c'est eux qui arrachaient la lecture.
  const [followState, setFollowState] = useState<FollowState>('following');
  const followStateRef = useRef<FollowState>('following');
  const setFollow = useCallback((next: FollowState) => {
    if (next === 'detached' && runningRef.current) readDuringRun.current = true;
    followStateRef.current = next;
    setFollowState(next);
  }, []);
  const touching = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const holdStartY = useRef(0);
  /** Tour en cours, lu par `setFollow` sans passer par le rendu. */
  const runningRef = useRef(false);
  runningRef.current = running;
  /** L'utilisateur a remonté (ou maintenu) pendant CE tour : on ne le
   *  ramène pas de force, mais le tour suivant repart collé. */
  const readDuringRun = useRef(false);
  const prevScrollTop = useRef(0);
  const resumeAttempt = useRef(0);
  /** Descente en bas, sans jamais détacher (mouvement vers le bas). */
  const scrollToEnd = useCallback(() => {
    const element = transcript.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);
  /** Reprise explicite (bouton, envoi) : retour en bas à la frame suivante. */
  const resumeFollow = useCallback(() => {
    if (followStateRef.current === 'following') return;
    setFollow('returning');
    const attempt = ++resumeAttempt.current;
    requestAnimationFrame(() => {
      // L'utilisateur est remonté entre-temps : tentative périmée, on
      // ne le ramène pas de force.
      if (resumeAttempt.current !== attempt) return;
      scrollToEnd();
      setFollow('following');
    });
  }, [scrollToEnd, setFollow]);
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const onScroll = () => {
      const metrics = {
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      };
      const direction =
        element.scrollTop < prevScrollTop.current
          ? 'up'
          : element.scrollTop > prevScrollTop.current
            ? 'down'
            : null;
      prevScrollTop.current = element.scrollTop;
      if (!direction) return;
      setFollow(
        nextFollowState(followStateRef.current, {
          type: 'scroll',
          direction,
          distance: distanceToEnd(metrics),
          overflow: hasOverflow(metrics),
        }),
      );
    };
    const clearHold = () => {
      if (holdTimer.current !== undefined) {
        clearTimeout(holdTimer.current);
        holdTimer.current = undefined;
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touching.current = true;
      holdStartY.current = event.touches[0]?.clientY ?? 0;
      clearHold();
      // Appui maintenu sans glisser = l'utilisateur s'arrête pour lire :
      // on détache après HOLD_DETACH_MS pour que le relâchement ne ramène
      // pas la vue en bas. Un simple tap (moins de 250 ms) ne détache pas.
      holdTimer.current = setTimeout(() => {
        holdTimer.current = undefined;
        if (!touching.current) return;
        setFollow(
          nextFollowState(followStateRef.current, {
            type: 'hold',
            overflow: hasOverflow({
              scrollHeight: element.scrollHeight,
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
            }),
          }),
        );
      }, HOLD_DETACH_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      // Glissement = défilement : c'est l'événement `scroll` qui décide,
      // pas l'appui maintenu.
      const y = event.touches[0]?.clientY ?? 0;
      if (Math.abs(y - holdStartY.current) > HOLD_MOVE_TOLERANCE_PX)
        clearHold();
    };
    const onTouchEnd = () => {
      touching.current = false;
      clearHold();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      clearHold();
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [setFollow]);
  // --- Pied de réponse (lot 3) : métriques `/reasoning-stats` par
  // message assistant, lues APRÈS le tour (jamais l'estimation live).
  // Le serveur les range sous l'id du message assistant (tours avec
  // usage) ou du message de raisonnement (tours avec reasoning) : on
  // essaie les deux, dans cet ordre — comme l'effet des totaux de
  // session ci-dessous. `requested` ne retient qu'un id dont les stats
  // ont été obtenues (succès avec `model`) : un id vide ou en échec est
  // retenté au passage suivant de l'effet.
  const [responseStats, setResponseStats] = useState<
    Record<string, ReasoningRunStats>
  >({});
  const responseStatsRequested = useRef(new Set<string>());
  const fetchResponseStats = useCallback(
    async (assistantId: string) => {
      // `requested` n'est marqué que sur succès avec `model` (voir
      // `fetchResponseStatsForMessage`) : un fetch vide ou en échec
      // laisse l'id retentable par un passage ultérieur de l'effet.
      const stats = await fetchResponseStatsForMessage(
        responseStatsRequested.current,
        assistantId,
        reasoningForMessage({ id: assistantId }),
        (id) =>
          api<ReasoningRunStats>(
            `/reasoning-stats?messageId=${encodeURIComponent(id)}`,
          ),
      );
      if (stats) {
        setResponseStats((previous) =>
          previous[assistantId]
            ? previous
            : { ...previous, [assistantId]: stats },
        );
      }
    },
    [reasoningForMessage],
  );
  useEffect(() => {
    // Hors run uniquement : pendant le streaming les stats ne sont pas
    // finales (le panneau raisonnement re-fetch déjà à la fin du tour).
    if (running) return;
    for (const message of agent.messages) {
      if (
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.trim()
      )
        void fetchResponseStats(message.id);
    }
  }, [running, agent.messages, fetchResponseStats]);
  // --- Tour interrompu (pied « Interrompu », session courante) ---------
  const stopRequestedRef = useRef(false);
  const [interruptedIds, setInterruptedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const prevRunningForInterrupt = useRef(false);
  useEffect(() => {
    if (prevRunningForInterrupt.current && !running) {
      if (stopRequestedRef.current) {
        const last = [...agent.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        if (last) {
          setInterruptedIds((previous) => new Set(previous).add(last.id));
        }
        stopRequestedRef.current = false;
      }
    }
    prevRunningForInterrupt.current = running;
  }, [running, agent.messages]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => {
        runError.current = error.message;
        setError(error.message);
      },
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        runError.current = event.message;
        setError(event.message);
      },
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    // Le `connect` rejoue tous les événements du thread. Sans remise à
    // zéro, AG-UI ré-applique les deltas sur des messages déjà présents
    // (`TEXT_MESSAGE_CONTENT` s'ajoute, seul le START se déduplique) : la
    // réponse apparaît alors en double. Le replay serveur redevient donc
    // la seule source de vérité du transcript.
    const previousMessages = agent.messages;
    agent.setMessages([]);
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (!active) return;
        // Replay impossible : on rend à l'écran ce qu'il affichait avant.
        if (!agent.messages.length) agent.setMessages(previousMessages);
        setError(
          e instanceof Error ? e.message : 'Conversation could not connect.',
        );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const executeTurn = async (): Promise<{
    ok: boolean;
    /** Au moins une réponse assistant non vide a été produite. */
    answered: boolean;
  }> => {
    setError('');
    runError.current = '';
    stopRequestedRef.current = false;
    setRunning(true);
    resetSteps();
    try {
      const result = await copilotkit.runAgent({ agent });
      const answered = result.newMessages.some(
        (message) =>
          message.role === 'assistant' &&
          typeof message.content === 'string' &&
          message.content.trim(),
      );
      if (!answered)
        throw new Error(
          runError.current ||
            'Le modèle n’a produit aucune réponse. Réessaie, ou choisis un autre modèle dans le sélecteur.',
        );
      onSaved();
      return { ok: true, answered: true };
    } catch (e) {
      setError(
        runError.current ||
          (e instanceof Error
            ? e.message
            : 'Le tour a échoué. Votre conversation reste enregistrée.'),
      );
      return { ok: false, answered: false };
    } finally {
      setRunning(false);
    }
  };
  const runPrompt = async (
    text: string,
    meta?: {
      attachments?: string[];
      historyPrompt?: string;
      quote?: { text: string; comment: string } | null;
    },
  ) => {
    const sentDraft = draftRef.current;
    // Citation attachée à CE tour (snapshot pris à l'envoi / à la mise en
    // file), pas la carte courante : un tour en file ne doit jamais
    // effacer une carte posée après sa mise en file.
    const sentQuote = meta?.quote ?? null;
    const historyEntry: PromptHistoryEntry = {
      prompt: meta?.historyPrompt ?? text,
      mode: 'chat',
      ...(meta?.attachments?.length ? { attachments: meta.attachments } : {}),
    };
    // Une entrée sans texte utilisateur (citation seule, sans brouillon ni
    // commentaire) n'a rien à rappeler : on ne la pousse pas.
    const historyPushed = historyEntry.prompt.trim() !== '';
    const userMessageId = crypto.randomUUID();
    agent.addMessage({
      id: userMessageId,
      role: 'user',
      content: contextualMessage(text, pageContext),
    });
    // Historique poussé à l'envoi (retiré en cas d'échec, ci-dessous).
    if (historyPushed) pushPromptHistory(historyEntry);
    // Le brouillon n'est vidé qu'après `addMessage` réussi ; la carte de
    // citation attachée à ce tour est retirée avec lui — seulement si
    // c'est toujours elle qui est affichée. Un message chargé depuis la
    // file est consommé : Échap ne doit plus pouvoir le remettre en file.
    clearDraft();
    setEditingQueued(null);
    if (
      sentQuote &&
      quoteRef.current?.text === sentQuote.text &&
      quoteRef.current?.comment === sentQuote.comment
    )
      setQuote(null);
    setSource('');
    setSourceOpen(false);
    // L'envoi est un geste explicite : il ré-attache le suivi en bas.
    resumeFollow();
    const turn = await executeTurn();
    if (!turn.ok) {
      // Échec du tour : l'entrée d'historique est retirée et le brouillon
      // restauré si le composer n'a pas changé depuis l'envoi ; la carte
      // de citation est restaurée sauf si une autre carte est ouverte
      // entre-temps (comparaison sur l'état courant via `quoteRef`, pas
      // sur la valeur capturée à l'envoi — l'ancien test `quote === null`
      // ne pouvait jamais être vrai quand `sentQuote` existait).
      //
      // Aucune réponse produite (modèle en erreur, clé morte, quota) : le
      // message optimiste est retiré. Changer de modèle puis renvoyer ne
      // crée donc pas de bulle utilisateur en double — le tour repart
      // proprement sur le nouveau modèle, avec le même historique.
      if (!turn.answered)
        agent.setMessages(
          agent.messages.filter((message) => message.id !== userMessageId),
        );
      if (historyPushed) removePromptHistoryEntry(historyEntry);
      if (draftRef.current === '') restoreDraft(sentDraft);
      if (sentQuote && !quoteRef.current) setQuote(sentQuote);
    }
  };
  /** Régénère la dernière réponse : tronque au dernier message user
   *  (le snapshot serveur est écrasé au prochain run — pas de fantôme). */
  const retryTurn = () => {
    if (running) return;
    const msgs = agent.messages;
    let lastUser = -1;
    msgs.forEach((message, index) => {
      if (message.role === 'user') lastUser = index;
    });
    if (lastUser < 0) return;
    stopAllSpeech();
    agent.setMessages(msgs.slice(0, lastUser + 1));
    // Régénération demandée : on repart du bas, comme pour un envoi.
    resumeFollow();
    void executeTurn();
  };
  const send = (
    text: string,
    meta?: {
      attachments?: string[];
      historyPrompt?: string;
      quote?: { text: string; comment: string } | null;
    },
  ) => {
    if (!text.trim() || !loaded || !contextReady || paused) return;
    stopAllSpeech();
    // While a turn runs, hold the message and start it as soon as the turn ends.
    if (running) {
      // Le texte en file porte déjà le bloc `[Citation : …]` et les
      // blocs de pièces jointes : on snapshotte le texte utilisateur et
      // la citation avec lui, et la carte est consommée (sinon la même
      // citation serait ré-appliquée au message suivant).
      setQueued((current) => enqueueQueued(current, text.trim(), meta));
      if (
        meta?.quote &&
        quoteRef.current?.text === meta.quote.text &&
        quoteRef.current?.comment === meta.quote.comment
      )
        setQuote(null);
      clearDraft();
      setSource('');
      setSourceOpen(false);
      // La bulle en file apparaît en bas : on y descend tout de suite.
      resumeFollow();
      return;
    }
    void runPrompt(text, meta);
  };
  const queuedRef = useRef<QueuedMessage[]>([]);
  queuedRef.current = queued;
  useEffect(() => {
    if (running || paused || !loaded || !contextReady) return;
    if (!queuedRef.current.length) return;
    const { next, rest } = dequeueQueued(queuedRef.current);
    if (!next) return;
    setQueued(rest);
    void runPrompt(next.text, {
      historyPrompt: next.historyPrompt,
      attachments: next.attachments,
      quote: next.quote,
    });
  }, [running, queued, loaded, contextReady, paused]);
  // --- Historique des prompts (Lot 5, étape 5) : ↑/↓ quand le curseur
  // est sur la première/dernière ligne, Maj+↑ pour la liste. `null` =
  // pas de navigation en cours ; le brouillon d'origine est restauré en
  // redescendant sous la première entrée.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyBaseRef = useRef('');
  const historyPrev = () => {
    const entries = loadPromptHistory();
    if (!entries.length) return;
    if (historyIndex === null) historyBaseRef.current = draftRef.current;
    const next = Math.min((historyIndex ?? -1) + 1, entries.length - 1);
    setHistoryIndex(next);
    setDraft(entries[next].prompt);
  };
  const historyNext = () => {
    if (historyIndex === null) return;
    const entries = loadPromptHistory();
    const next = historyIndex - 1;
    if (next < 0) {
      setHistoryIndex(null);
      setDraft(historyBaseRef.current);
    } else {
      setHistoryIndex(next);
      setDraft(entries[next].prompt);
    }
  };
  const historySelect = (prompt: string) => {
    setHistoryIndex(null);
    setDraft(prompt);
    composerInputRef.current?.focus();
  };
  /** La frappe dans le composer annule la navigation d'historique. */
  const onDraftChange = (value: string) => {
    setHistoryIndex(null);
    setDraft(value);
  };
  /** Alt+Entrée : tête de file pendant un tour, envoi sinon (`steer`
   *  hors périmètre — la file ne fait que prioriser). Passe par le même
   *  assemblage que `onSubmit` (`prepareSend` + citation + noms de pièces
   *  jointes) : l'ancien chemin envoyait le brouillon brut, donc les
   *  pièces jointes affichées n'étaient jamais uploadées et la carte de
   *  citation restait ouverte pour le message suivant (revue finale,
   *  Important 1). Même garde anti-double-submit que `onSubmit` (prise
   *  synchrone de `sendingRef` avant `await prepareSend`, libération
   *  dans `finally`). */
  const queueFront = () => {
    if (sendingRef.current) return;
    // Capture synchrone (comme la fermeture d'`onSubmit`) : le brouillon,
    // la carte et la source ne doivent pas dériver pendant `prepareSend`.
    const draftAtSubmit = draftRef.current;
    const quoteAtSubmit = quoteRef.current;
    const sourceAtSubmit = source;
    if (
      (!draftAtSubmit.trim() && !quoteAtSubmit && !attachments.items.length) ||
      !loaded ||
      !contextReady ||
      paused
    )
      return;
    sendingRef.current = true;
    void (async () => {
      try {
        const userText = [draftAtSubmit.trim(), quoteAtSubmit?.comment.trim()]
          .filter(Boolean)
          .join('\n\n');
        const quoted = quoteAtSubmit
          ? userText
            ? `${userText}\n\n[Citation : ${quoteAtSubmit.text}]`
            : `[Citation : ${quoteAtSubmit.text}]`
          : draftAtSubmit;
        const attachmentNames = attachments.items.map((a) => a.name);
        const text = await attachments.prepareSend(quoted);
        const finalText = `${sourceAtSubmit ? `From ${sourceAtSubmit}:\n\n` : ''}${text}`;
        const meta = {
          attachments: attachmentNames,
          historyPrompt: userText,
          quote: quoteAtSubmit ?? undefined,
        };
        if (running) {
          // Comme la branche « en cours » de `send`, mais en tête de
          // file : le snapshot (citation, pièces jointes) voyage avec le
          // message, et la carte est consommée — sinon elle s'appliquerait
          // au message d'après (mauvaise attribution).
          stopAllSpeech();
          setQueued((current) => enqueueQueuedFront(current, finalText, meta));
          if (
            meta.quote &&
            quoteRef.current?.text === meta.quote.text &&
            quoteRef.current?.comment === meta.quote.comment
          )
            setQuote(null);
          clearDraft();
          setSource('');
          setSourceOpen(false);
          resumeFollow();
          return;
        }
        void send(finalText, meta);
      } catch (error) {
        // prepareSend a échoué (timeout, upload, rattachement) :
        // erreur visible, brouillon conservé.
        setError(error instanceof Error ? error.message : 'Envoi impossible.');
      } finally {
        sendingRef.current = false;
      }
    })();
  };
  /** Mod+. / Maj+Mod+. : cycle entre les Dots (chip agent, étape 4). */
  const cycleDot = (direction: 1 | -1) => {
    const list = dots ?? [dot];
    if (list.length < 2 || !onChooseDot) return;
    const index = list.findIndex((candidate) => candidate.id === dot.id);
    const next = list[(index + direction + list.length) % list.length];
    if (next && next.id !== dot.id) onChooseDot(next);
  };
  /** Échap : annule le chargement en file, sinon ferme le menu, sinon
   *  retire la carte de citation. */
  const handleEscape = () => {
    if (cancelQueuedEdit()) return;
    if (composerToolsOpen) {
      setComposerToolsOpen(false);
      return;
    }
    if (quote) setQuote(null);
  };
  /** Chip agent (étape 4) : avant la chip modèle, seulement si plusieurs
   *  Dots — un clic cycle comme Mod+. */
  const agentChip =
    (dots?.length ?? 0) > 1 ? (
      <button
        type="button"
        className="agent-chip"
        aria-label={`Agent actif : ${dot.name} — changer d'agent (Mod+.)`}
        title={`Agent : ${dot.name} — Mod+. pour changer`}
        onClick={() => cycleDot(1)}
      >
        {dot.name}
      </button>
    ) : undefined;
  /** Carte de citation (étape 6) : texte cité + champ commentaire. */
  const quoteCard = quote ? (
    <div className="quote-card">
      <blockquote>{quote.text}</blockquote>
      <div className="quote-card-row">
        <input
          aria-label="Commentaire sur la citation"
          placeholder="Ajouter un commentaire…"
          value={quote.comment}
          onChange={(event) =>
            setQuote({ text: quote.text, comment: event.target.value })
          }
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Retirer la citation"
          title="Retirer la citation"
          onClick={() => setQuote(null)}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  ) : undefined;
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  // Suivi du tour en cours : la machine décide, pas le run. Pendant le
  // run, le contenu qui grandit fait suivre (à la frame) seulement si
  // l'état est `following` / `anchored` ; un lecteur `detached` n'est
  // jamais ramené de force, et le doigt posé bloque le défilement
  // programmatique. À la fin du run : plus aucun saut forcé en bas.
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const loop = () => {
      const state = followStateRef.current;
      if ((state === 'following' || state === 'anchored') && !touching.current)
        scrollToEnd();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [running, scrollToEnd]);
  // Chaque tour repart collé au point de génération : le texte arrive sous
  // les yeux sans avoir à défiler (retour du 2026-11-15 : « je dois
  // scroller pour voir la dernière génération »). Seul un lecteur qui a
  // remonté pendant le tour précédent garde sa position ; le tour d'après
  // le ramène.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) {
      const keepDetached = readDuringRun.current;
      readDuringRun.current = false;
      setFollow(
        nextFollowState(followStateRef.current, {
          type: 'turn-started',
          keepDetached,
        }),
      );
      if (!keepDetached) scrollToEnd();
    }
    wasRunning.current = running;
  }, [running, scrollToEnd, setFollow]);
  // Un message ajouté (le message user, le texte assistant, un appel
  // d'outil) ne ré-attache plus : la machine décide — `following` /
  // `anchored` restent en bas, `detached` / `returning` ne bougent pas.
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const next = nextFollowState(followStateRef.current, {
      type: 'content-grew',
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    });
    setFollow(next);
    if (next === 'following') scrollToEnd();
  }, [agent.messages.length, scrollToEnd, setFollow]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  useHumanInTheLoop(
    {
      name: connectionActionTool.name,
      description: connectionActionTool.description,
      parameters: connectionActionSchema,
      render: (props) => (
        <ConnectionActionCard {...props} threadId={thread.id} />
      ),
    },
    [thread.id],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  // MVC-Statut (lot 2.2) : le statut du run et le flux d'activité sont
  // dérivés en un seul point, dans le modèle (`deriveRawRunStatus` garde
  // la priorité voix > flash > pause > recherche > écriture > raisonnement
  // > attente > repos — voir `specs/mascot-states.md`). Les vues
  // (Mascot, rail, barre, StepCard) ne font que refléter.
  useEffect(() => {
    pushRunFrame({
      messages: agent.messages,
      voiceActive: voice.status === 'active',
      flash,
      paused,
      running,
      reasoningLive: reasonPanel?.live ?? false,
    });
  }, [agent.messages, voice.status, flash, paused, running, reasonPanel?.live]);
  const mascotState = useRunMascotState();
  // Un id ne peut apparaître qu'une fois : un message rejoué (reconnexion,
  // replay serveur) ne doit jamais produire deux bulles identiques.
  const seenMessageIds = new Set<string>();
  const visible: typeof agent.messages = [];
  for (const message of agent.messages) {
    if (seenMessageIds.has(message.id)) continue;
    const shown =
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          // Lot 4 : tout appel d'outil rend le message visible, pas
          // seulement les outils computer / page / connexion — sinon
          // les tours « recherche seule » n'affichent jamais leurs
          // blocs d'outils (repli transcript, étape 6).
          (message.toolCalls?.length ?? 0) > 0));
    if (!shown) continue;
    seenMessageIds.add(message.id);
    visible.push(message);
  }
  // Live activity feed (commands, websites, files, searches) + collapsed bubbles.
  // Dérivé dans RunStatusModel (miroir via `useRunActivity`).
  const activity = useRunActivity();
  useEffect(() => {
    if (!reasonPanel) return;
    // Tablette/bureau (≥701px, rail docké) : le rail d'activités reste affiché
    // et le panneau de raisonnement se pose à côté. En dessous, les deux
    // overlays se recouvriraient : on conserve l'exclusivité d'origine.
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 701px)').matches
    )
      return;
    onRailChange(false);
  }, [reasonPanel, onRailChange]);
  // Muse-style: open the browser pane when the agent starts navigating.
  // App collapses the activity rail into the pop-pop bubble while it is open.
  const browserOpenedForRun = useRef(false);
  useEffect(() => {
    if (!running) {
      browserOpenedForRun.current = false;
      return;
    }
    if (browserOpenedForRun.current || !latestBrowserCall) return;
    browserOpenedForRun.current = true;
    // Mobile : le panneau ordinateur est plein écran — on ne l'ouvre pas
    // par-dessus la réponse, l'utilisateur l'ouvre quand il veut.
    if (!panelsMayAutoOpen()) return;
    onComputer?.();
  }, [running, latestBrowserCall, onComputer]);
  // Cumulative session tokens for the cetas-style token bar.
  const [session, setSession] = useState({
    in: 0,
    out: 0,
    cost: 0,
    cached: 0,
    /** Vrai dès qu'un tour a un coût inconnu (modèle non tarifé). */
    unknownCost: false,
  });
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      500,
    );
    return () => clearInterval(timer);
  }, [running]);
  const lastAssistant = agent.messages
    .filter((message) => message.role === 'assistant')
    .at(-1);
  const liveOut =
    typeof lastAssistant?.content === 'string'
      ? Math.round(lastAssistant.content.length / 4)
      : 0;
  const liveRate = elapsed > 0 ? Math.round(liveOut / elapsed) : 0;
  const prevRunForTokens = useRef(false);
  useEffect(() => {
    if (!prevRunForTokens.current || running) {
      prevRunForTokens.current = running;
      return;
    }
    prevRunForTokens.current = running;
    const lastReasoning = agent.messages
      .filter((message) => message.role === 'reasoning')
      .at(-1);
    // Stats de session : l'usage est enregistré pour le message assistant même
    // sans reasoning ; on retombe sur le message de raisonnement pour les
    // anciens tours.
    const ids = [lastAssistant?.id, lastReasoning?.id].filter(
      (id): id is string => !!id,
    );
    if (!ids.length) return;
    void (async () => {
      for (const id of ids) {
        const stats = await api<ReasoningRunStats>(
          `/reasoning-stats?messageId=${encodeURIComponent(id)}`,
        );
        if (!stats?.model) continue;
        // Coût inconnu = tokens présents mais non tarifés (pas une
        // absence d'usage : tokens null → rien à facturer, F7).
        const hasTokens =
          (stats.promptTokens ?? 0) + (stats.completionTokens ?? 0) > 0;
        setSession((previous) => ({
          in: previous.in + (stats.promptTokens ?? 0),
          out: previous.out + (stats.completionTokens ?? 0),
          cost: previous.cost + (stats.costUsd ?? 0),
          cached: previous.cached + (stats.cachedTokens ?? 0),
          unknownCost:
            previous.unknownCost || (hasTokens && stats.costUsd == null),
        }));
        return;
      }
    })().catch(() => {
      /* token totals are best-effort */
    });
  }, [running, agent.messages]);
  // Persist the turn outcome + activity so the Muse activity timeline can show
  // conversations that were never open in this browser. While the turn runs we
  // also post on a throttle so the rail follows the work live; the final post
  // lands on completion, with the one-line summary.
  const postActivity = useCallback(
    (withSummary: boolean) => {
      const last = agent.messages
        .filter((message) => message.role === 'assistant')
        .at(-1);
      const text = typeof last?.content === 'string' ? last.content.trim() : '';
      if (!withSummary && !activity.length) return;
      const body: { summary?: string | null; activity: unknown[] } = {
        activity: activity.slice(-60),
      };
      if (withSummary)
        body.summary = text.replace(/\s+/g, ' ').slice(0, 240) || null;
      void api(
        `/conversations/${encodeURIComponent(thread.id)}/activity`,
        'POST',
        body,
      ).catch(() => {
        /* best-effort */
      });
    },
    [agent.messages, activity, thread.id],
  );
  // Live: throttled posts while the turn is running.
  const lastPostAt = useRef(0);
  useEffect(() => {
    if (!running || runError.current) return;
    const now = Date.now();
    if (now - lastPostAt.current < 2000) return;
    lastPostAt.current = now;
    postActivity(false);
  }, [running, activity, postActivity]);
  // Final: one post when the turn completes.
  const activityPosted = useRef(true);
  useEffect(() => {
    if (running) {
      activityPosted.current = false;
      return;
    }
    if (activityPosted.current) return;
    activityPosted.current = true;
    if (runError.current) return;
    postActivity(true);
  }, [running, postActivity]);
  // Ligne de statut sous le tour (lot 3) : un seul libellé, dérivé des
  // messages — jamais empilé avec un autre signal « ça travaille ».
  const turnStatus = deriveTurnStatus(agent.messages, running);
  // Repli transcript des blocs d'outils, mémoïsé par message (revue
  // finale, Important 4) : `stepsFromTranscriptMessage` fait `JSON.parse`
  // des arguments de chaque appel ; sans mémo, `renderTools` le relançait
  // pour tous les messages à chaque rendu — y compris chaque token en
  // streaming et chaque frappe au composer. La carte n'est recalculée que
  // quand `agent.messages` (nouveau tour, résultat d'outil arrivé) ou
  // l'historique enregistré change. Le tour courant reste exclu au rendu
  // (couvert par le bloc live) — ce test, bon marché, n'est pas mémoïsé.
  const fallbackStepsByMessageId = useMemo(() => {
    const byId = new Map<string, AgentStep[]>();
    for (const message of agent.messages) {
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
      if (history.some((entry) => entry.messageId === message.id)) continue;
      byId.set(
        message.id,
        stepsFromTranscriptMessage(message, agent.messages).filter(
          (step) =>
            step.toolName &&
            step.toolName !== pageReviewTool.name &&
            step.toolName !== connectionActionTool.name,
        ),
      );
    }
    return byId;
  }, [agent.messages, history]);
  return (
    <div className={`live-chat ${visible.length ? 'in-conversation' : ''}`}>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript-shell">
        {!visible.length && (
          <div className="chat-welcome">
            <Mascot avatar={dot.avatar} name={dot.name} state={mascotState} />
            <h1>Par où commencer ?</h1>
            <p>{dot.instructions}</p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          scrollRef={transcript}
          renderTools={(message) => {
            // Phase 3 : la carte de progression remplace le rendu brut
            // pour les tours qui ont des étapes enregistrées.
            const recorded = history.find((h) => h.messageId === message.id);
            if (recorded) {
              return <StepCard steps={recorded.steps} live={false} />;
            }
            // Lot 4, étape 6 : repli transcript — les outils non-computer
            // ne rendent plus `null` (rechargement, historique live
            // perdu). La carte computer reste rendue par
            // `CopilotChatToolCallsView` juste après, tout comme les
            // cartes dédiées `PageReviewCard` (pageReviewTool) et
            // `ConnectionActionCard` (connectionActionTool) enregistrées
            // via `useHumanInTheLoop` : le repli ne reprend ici que les
            // outils sans carte dédiée (pas de doublon).
            // Placement lot 3 inchangé : tout reste dans `renderTools`,
            // après le bloc live et avant la bulle (voir ChatTranscript).
            // Pendant le run, le tour courant est couvert par le bloc
            // live : on ne double pas sa carte. Le repli est mémoïsé
            // par message (voir `fallbackStepsByMessageId` ci-dessus).
            const isCurrentTurn = running && message.id === lastAssistant?.id;
            const fallback = isCurrentTurn
              ? []
              : (fallbackStepsByMessageId.get(message.id) ?? []);
            return (
              <>
                {fallback.length > 0 && (
                  <StepCard steps={fallback} live={false} />
                )}
                <CopilotChatToolCallsView
                  message={message}
                  messages={agent.messages}
                />
              </>
            );
          }}
          reasoningForMessage={reasoningForMessage}
          onOpenReasoning={openReasoning}
          streaming={running}
          running={running}
          onRetry={retryTurn}
          onQuote={quoteSelection}
          threadId={thread.id}
          dotId={dot.id}
          model={modelControls.selectedModelLabel ?? undefined}
          liveSteps={steps}
          thinkingLabel={`${dot.name} is thinking`}
          responseStats={responseStats}
          agentName={dot.name}
          interruptedIds={interruptedIds}
          statusLabel={turnStatus ? TURN_STATUS_LABELS[turnStatus] : null}
          statusKind={turnStatus}
          tts={{
            mode: settings?.ttsMode ?? 'browser',
            voice: settings?.ttsVoice ?? '',
            rate: settings?.ttsRate ?? 1,
            pauseSentenceMs: settings?.ttsPauseSentenceMs ?? 300,
            pauseParagraphMs: settings?.ttsPauseParagraphMs ?? 600,
            provider: settings?.ttsProvider ?? null,
            model: settings?.ttsModel ?? null,
          }}
        />
        {queued.map((item) => (
          <div className="chat-bubble user pending" key={item.id}>
            <button
              type="button"
              className="queued-remove"
              aria-label="Retirer de la file"
              title="Retirer de la file"
              onClick={(event) => {
                event.stopPropagation();
                setQueued((current) => removeQueued(current, item.id));
              }}
            >
              <X size={14} />
            </button>
            <button
              type="button"
              className="queued-load"
              aria-label="Charger ce message dans l'éditeur"
              title="Cliquer pour modifier — Échap annule"
              onClick={() => loadQueued(item)}
            >
              <UserMessageContent content={item.text} />
            </button>
          </div>
        ))}
        {/* Reprise explicite du suivi : visible seulement quand le lecteur
            est remonté (`detached`). Bouton collant en bas du transcript —
            ni flottant magique, ni réattachement forcé. */}
        {followState === 'detached' && (
          <button
            type="button"
            className="scroll-to-bottom-btn"
            aria-label="Revenir en bas de la conversation"
            onClick={resumeFollow}
          >
            <ArrowDown size={14} aria-hidden="true" />
            Revenir en bas
          </button>
        )}
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error || modelError) && (
        <div className="chat-error" role="alert">
          {error || voice.error || modelError}
          {error && (
            <button
              onClick={() => {
                setError('');
                // Même règle qu'au montage : le replay serveur reconstruit
                // le transcript, il ne se superpose pas à l'existant.
                const previousMessages = agent.messages;
                agent.setMessages([]);
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => {
                    if (!agent.messages.length)
                      agent.setMessages(previousMessages);
                    setError(e.message);
                  });
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      <ReasoningPanel
        open={reasonPanel !== null}
        onClose={() => setReasonPanel(null)}
        docked={railOpen}
        modelName={modelControls.selectedModelLabel || 'Modèle'}
        live={reasonPanel?.live ?? false}
        text={reasonPanelText}
        stats={reasonStats}
        translation={translation}
        translating={translating}
        translateError={translateError}
        showTranslation={showTranslation}
        onTranslate={translateReasoning}
        onToggleTranslation={() => setShowTranslation((v) => !v)}
      />
      <ActivityPanel
        open={railOpen}
        onClose={() => onRailChange(false)}
        dot={dot}
        dots={dots ?? [dot]}
        conversations={conversations ?? [thread]}
        currentThreadId={thread.id}
        liveEvents={activity}
        terminalActivity={terminalActivity}
        running={running}
        paused={paused}
        mascotState={mascotState}
        tasks={tasks ?? []}
        settings={
          settings ?? {
            name: dot.name,
            paused,
            researchAllowed: true,
            memoryAllowed: true,
            replyStyle: 'standard',
            replyLanguage: 'fr',
            ttsMode: 'browser',
            ttsVoice: '',
            ttsRate: 1,
            ttsPauseSentenceMs: 300,
            ttsPauseParagraphMs: 600,
            ttsProvider: null,
            ttsModel: null,
          }
        }
        onOpenConversation={(id) => onOpenConversation?.(id)}
        onOpenComputer={() => {
          onRailChange(false);
          onComputer?.();
        }}
        onOpenTerminal={onOpenTerminal}
        onOpenSettings={() => onOpenSettings?.()}
        onOpenTasks={() => onOpenTasks?.()}
      />
      {!railOpen && !reasonPanel && (
        <ActivityTab
          dot={dot}
          running={running}
          onOpen={() => {
            onClosePane?.();
            onRailChange(true);
          }}
        />
      )}
      <div className="chat-token-bar">
        <Mascot
          name={dot.name}
          avatar={dot.avatar}
          small
          animate
          decorative
          state={mascotState}
        />
        <div className="chat-token-actions">
          <button
            className={`icon-button ${notify ? 'active' : ''}`}
            aria-label="Notifications de réponse"
            title={
              notify
                ? 'Notifications activées'
                : 'Me notifier quand la réponse est prête'
            }
            onClick={() => void toggleNotify()}
          >
            {notify ? <Bell size={16} /> : <BellOff size={16} />}
          </button>
          <button
            className="icon-button"
            aria-label="Ouvrir la vue intervention"
            title="Vue intervention (plein écran)"
            onClick={() => setStageOpen(true)}
          >
            <Maximize2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Enregistrer la conversation en page"
            title="Enregistrer la conversation en page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Planifier une tâche dans cette conversation"
            title="Planifier une tâche"
            onClick={onSchedule}
          >
            <Clock3 size={16} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={16} />
            ) : (
              <PhoneOff size={16} />
            )}
          </button>
        </div>
        <span className="chat-token-info">
          {running && (
            <>
              ⏱ {elapsed}s · ~{liveOut} tok · {liveRate} tok/s ·{' '}
            </>
          )}
          ↑ {session.in} (input) ↓ {session.out} (output) ⇅ {session.cached} en
          cache
          {session.in > 0
            ? ` (${Math.round((session.cached / session.in) * 100)} %)`
            : ''}{' '}
          Tokens · Coût estimé :{' '}
          {session.unknownCost && session.cost === 0 ? (
            <span title="Modèle non tarifé : coût réel inconnu (voir OpenRouter → Activity)">
              ~
            </span>
          ) : (
            <>
              ${session.cost.toFixed(4).replace('.', ',')}
              {session.unknownCost && (
                <span title="Coût partiel : certains tours utilisent un modèle non tarifé">
                  {' '}
                  (~)
                </span>
              )}
            </>
          )}
        </span>
      </div>
      <Composer
        text={draft}
        onTextChange={onDraftChange}
        textareaRef={composerInputRef}
        placeholder={`Demander à ${dot.name}`}
        inputAriaLabel={`Discuter avec ${dot.name}`}
        canSubmitOnEnter={!!draft.trim() && loaded && contextReady && !paused}
        onSubmit={() => {
          if (sendingRef.current) return;
          sendingRef.current = true;
          void (async () => {
            try {
              // Citation structurée : le brouillon tapé est préservé —
              // contenu envoyé = brouillon + commentaire + référence
              // citée ; l'historique retient le texte utilisateur
              // (brouillon + commentaire, sans le bloc de citation ni
              // les blocs de pièces jointes injectés).
              const userText = [draft.trim(), quote?.comment.trim()]
                .filter(Boolean)
                .join('\n\n');
              const quoted = quote
                ? userText
                  ? `${userText}\n\n[Citation : ${quote.text}]`
                  : `[Citation : ${quote.text}]`
                : draft;
              const attachmentNames = attachments.items.map((a) => a.name);
              const text = await attachments.prepareSend(quoted);
              void send(`${source ? `From ${source}:\n\n` : ''}${text}`, {
                attachments: attachmentNames,
                historyPrompt: userText,
                quote: quote ?? undefined,
              });
            } catch (error) {
              // prepareSend a échoué (timeout, upload, rattachement) :
              // erreur visible, brouillon conservé.
              setError(
                error instanceof Error ? error.message : 'Envoi impossible.',
              );
            } finally {
              sendingRef.current = false;
            }
          })();
        }}
        submitDisabled={
          (!draft.trim() && !attachments.items.length) ||
          attachments.uploading ||
          !loaded ||
          !contextReady ||
          paused
        }
        submitTitle={
          running ? 'Mettre en file (Ctrl+Entrée)' : 'Envoyer (Ctrl+Entrée)'
        }
        submitAriaLabel={running ? 'Mettre en file' : 'Envoyer'}
        sourceOpen={sourceOpen}
        onToggleSource={() => setSourceOpen((open) => !open)}
        source={source}
        onSourceChange={setSource}
        webSearchOn={webSearch && settings?.researchAllowed !== false}
        onToggleWebSearch={() => void toggleWebSearch()}
        webSearchDisabled={settings?.researchAllowed === false}
        menuOpen={composerToolsOpen}
        onToggleMenu={() => setComposerToolsOpen((open) => !open)}
        menu={
          <ComposerMenu
            dots={dots ?? []}
            activeDotId={dot.id}
            memories={memories ?? []}
            onSource={() => setSourceOpen(true)}
            onChooseDot={onChooseDot ?? (() => {})}
            onInsertMemory={(text) =>
              setDraft((current) => (current ? `${text}\n\n${current}` : text))
            }
            onSchedule={onSchedule}
            onComputer={onComputer}
            onCreateDot={onCreateDot}
            onAddFiles={() => attachmentBar.current?.openFilesPicker()}
            onAddFolder={() => attachmentBar.current?.openFolderPicker()}
            onClose={() => setComposerToolsOpen(false)}
            contextBudget={dot.contextBudget ?? null}
            onContextBudget={async (budget) => {
              try {
                await api(`/dots/${dot.id}/context-budget`, 'PUT', { budget });
                onSaved();
              } catch (cause) {
                setModelError(
                  cause instanceof Error
                    ? cause.message
                    : 'Budget de contexte non enregistré.',
                );
              }
            }}
            compactionStrategy={dot.compactionStrategy ?? 'native'}
            onCompactionStrategy={async (strategy) => {
              try {
                await api(`/dots/${dot.id}/compaction-strategy`, 'PUT', {
                  strategy,
                });
                onSaved();
              } catch (cause) {
                setModelError(
                  cause instanceof Error
                    ? cause.message
                    : 'Stratégie de compaction non enregistrée.',
                );
              }
            }}
          />
        }
        dotId={dot.id}
        modelValue={modelControls.modelValue}
        modelOptions={modelControls.models}
        defaultModelLabel={modelControls.defaultModelLabel}
        onModelSaved={onSaved}
        onModelError={setModelError}
        reasoningEffort={modelControls.reasoningEffort}
        onSetReasoningEffort={(effort) =>
          void modelControls.setReasoningEffort(effort)
        }
        reasoningLevels={modelControls.reasoningLevels}
        reasoningMandatory={modelControls.reasoningMandatory}
        reasoningDisabled={modelControls.reasoningBusy}
        stopButton={
          running ? (
            <button
              type="button"
              className="send-button stop"
              aria-label="Arrêter la réponse"
              title="Arrêter la réponse"
              onClick={() => {
                // Le pied du tour portera « Interrompu ».
                stopRequestedRef.current = true;
                copilotkit.stopAgent({ agent });
              }}
            >
              <Square size={16} />
            </button>
          ) : undefined
        }
        note={
          <>
            {dot.name} · {modelControls.selectedModelLabel || 'défaut'}
            {paused ? ' · en pause' : ''}
          </>
        }
        attachmentCards={
          <AttachmentBar ref={attachmentBar} attachments={attachments} />
        }
        agentChip={agentChip}
        quoteCard={quoteCard}
        historyEntries={loadPromptHistory()}
        onHistorySelect={historySelect}
        onHistoryPrev={historyPrev}
        onHistoryNext={historyNext}
        onQueueFront={queueFront}
        onOpenAttachments={() => attachmentBar.current?.openFilesPicker()}
        onCycleDot={cycleDot}
        onToggleSourceShortcut={() => setSourceOpen((open) => !open)}
        onToggleMenuShortcut={() => setComposerToolsOpen((open) => !open)}
        onEscape={handleEscape}
      />
      <InterventionStage
        open={stageOpen}
        onClose={() => setStageOpen(false)}
        dot={dot}
        messages={visible}
        events={activity}
        running={running}
        onStop={() => {
          stopRequestedRef.current = true;
          copilotkit.stopAgent({ agent });
        }}
      />
    </div>
  );
}
