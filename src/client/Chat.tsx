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
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  Bell,
  BellOff,
  Brain,
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Maximize2,
  Phone,
  PhoneOff,
  Plus,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import { ReasoningPanel } from './ReasoningPanel';
import { ActivityPanel } from './ActivityPanel';
import { ActivityTab } from './ActivityTab';
import { InterventionStage } from './InterventionStage';
import { deriveActivity } from '../shared/activity';
import type { ReasoningRunStats } from '../server/reasoning.js';
import type {
  CallReceipt,
  Conversation,
  Dot,
  Memory,
  Settings,
  Task,
} from '../shared/types';
import { modelKey, parseModelKey, type ModelsResponse } from '../shared/models';
import { Mascot } from './Mascot';
import { ComposerMenu } from './ComposerMenu';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';

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
  const { copilotkit } = useCopilotKit();
  const runError = useRef('');
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
  const [draft, setDraft] = useState('');
  const [queued, setQueued] = useState<string[]>([]);
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
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const [error, setError] = useState('');
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
      if (!seenReasoning.current.has(message.id)) {
        seenReasoning.current.add(message.id);
        setReasonPanel({ id: message.id, live: true });
        break;
      }
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
  const reasoningForMessage = (message: { id: string }): string | undefined => {
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
  };
  // --- End reasoning panel ----------------------------------------------------
  const [models, setModels] = useState<ModelsResponse>({
    default: null,
    providers: [],
  });
  const [modelError, setModelError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      void api<ModelsResponse>('/models')
        .then((value) => {
          if (active) setModels(value);
        })
        .catch(() => {});
    load();
    const onChange = () => load();
    window.addEventListener('models-changed', onChange);
    return () => {
      active = false;
      window.removeEventListener('models-changed', onChange);
    };
  }, []);
  const modelValue =
    dot.provider && dot.model ? modelKey(dot.provider, dot.model) : '';
  const defaultModelLabel = models.default
    ? (models.default.model ?? models.default.provider)
    : '';
  const selectedModel = dot.model ?? defaultModelLabel;
  const reasoningEffort = dot.reasoningEffort ?? '';
  const reasoningLabel =
    reasoningEffort === 'none'
      ? 'désactivée'
      : reasoningEffort === 'low'
        ? 'basse'
        : reasoningEffort === 'high'
          ? 'haute'
          : 'désactivée';
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const cycleReasoning = async () => {
    if (reasoningBusy) return;
    const order = ['', 'low', 'high'];
    const next = order[(order.indexOf(reasoningEffort) + 1) % order.length];
    setReasoningBusy(true);
    setModelError('');
    try {
      await api(`/dots/${dot.id}/reasoning`, 'PUT', {
        effort: next || null,
      });
      onSaved();
    } catch (err) {
      setModelError(
        err instanceof Error
          ? err.message
          : 'Réglage de réflexion indisponible.',
      );
    } finally {
      setReasoningBusy(false);
    }
  };
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
  const bottom = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const touching = useRef(false);
  const lastScrollAt = useRef(0);
  const scrollToBottom = (force = false) => {
    const element = transcript.current;
    if (!element) return;
    if (!force && (!following.current || touching.current)) return;
    const now = performance.now();
    if (!force && now - lastScrollAt.current < 150) return;
    lastScrollAt.current = now;
    element.scrollTop = element.scrollHeight;
  };
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const onScroll = () => {
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };
    const onTouchStart = () => {
      touching.current = true;
    };
    const onTouchEnd = () => {
      touching.current = false;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);
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
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const runPrompt = async (text: string) => {
    setError('');
    runError.current = '';
    setRunning(true);
    agent.addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: contextualMessage(text, pageContext),
    });
    setDraft('');
    setSource('');
    setSourceOpen(false);
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
    } catch (e) {
      setError(
        runError.current ||
          (e instanceof Error
            ? e.message
            : 'Le tour a échoué. Votre conversation reste enregistrée.'),
      );
    } finally {
      setRunning(false);
    }
  };
  const send = (text: string) => {
    if (!text.trim() || !loaded || !contextReady || paused) return;
    // While a turn runs, hold the message and start it as soon as the turn ends.
    if (running) {
      setQueued((current) => [...current, text.trim()]);
      setDraft('');
      setSource('');
      setSourceOpen(false);
      return;
    }
    void runPrompt(text);
  };
  const queuedRef = useRef<string[]>([]);
  queuedRef.current = queued;
  useEffect(() => {
    if (running || paused || !loaded || !contextReady) return;
    if (!queuedRef.current.length) return;
    const next = queuedRef.current[0];
    setQueued((current) => current.slice(1));
    void runPrompt(next);
  }, [running, queued, loaded, contextReady, paused]);
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  // Follow the conversation while a turn runs (throttled, respects touches).
  useEffect(() => {
    if (!running) {
      scrollToBottom(true);
      return;
    }
    let frame = 0;
    const loop = () => {
      scrollToBottom();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [running]);
  // Jump to the bottom when a new message is appended (e.g. the user's message).
  useEffect(() => {
    following.current = true;
    scrollToBottom(true);
  }, [agent.messages.length]);
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
  const lastToolCall = computerCalls.at(-1);
  const writingNow =
    !!lastToolCall &&
    /files_write|computer_exec|computer_type|create_space_page|edit_space_page/.test(
      lastToolCall.function.name,
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
  const activeToolName = lastToolCall?.function.name ?? '';
  const searchingNow =
    /search_web|read_public_page|web_search|web_fetch/.test(activeToolName) ||
    /computer_(navigate|snapshot|screenshot|read|click|scroll|key)/.test(
      activeToolName,
    );
  const mascotState =
    voice.status === 'active'
      ? 'listening'
      : flash
        ? flash
        : paused
          ? 'paused'
          : running
            ? searchingNow
              ? 'searching'
              : writingNow
                ? 'writing'
                : reasonPanel?.live
                  ? 'analyzing'
                  : 'thinking'
            : 'idle';
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : null,
    },
    [dot.id, dot.name, running, latestBrowserCall?.id, onComputer],
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              call.function.name === pageReviewTool.name ||
              call.function.name === connectionActionTool.name,
          ))),
  );
  // Live activity feed (commands, websites, files, searches) + collapsed bubbles.
  const activity = useMemo(
    () => deriveActivity(agent.messages),
    [agent.messages],
  );
  useEffect(() => {
    if (reasonPanel) onRailChange(false);
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
    onComputer?.();
  }, [running, latestBrowserCall, onComputer]);
  // Cumulative session tokens for the cetas-style token bar.
  const [session, setSession] = useState({ in: 0, out: 0, cost: 0 });
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
    if (!lastReasoning) return;
    void api<ReasoningRunStats>(
      `/reasoning-stats?messageId=${encodeURIComponent(lastReasoning.id)}`,
    )
      .then((stats) =>
        setSession((previous) => ({
          in: previous.in + (stats.promptTokens ?? 0),
          out: previous.out + (stats.completionTokens ?? 0),
          cost: previous.cost + (stats.costUsd ?? 0),
        })),
      )
      .catch(() => {
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
      <div className="chat-transcript" ref={transcript}>
        {!visible.length && (
          <div className="chat-welcome">
            <h1>Par où commencer ?</h1>
            <p>{dot.instructions}</p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderTools={(message) => (
            <CopilotChatToolCallsView
              message={message}
              messages={agent.messages}
            />
          )}
          reasoningForMessage={reasoningForMessage}
          onOpenReasoning={openReasoning}
          streaming={running}
        />
        {queued.map((text, index) => (
          <div className="chat-bubble user pending" key={`queued-${index}`}>
            {text}
          </div>
        ))}
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
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
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
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
        modelName={selectedModel || 'Modèle'}
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
        running={running}
        paused={paused}
        tasks={tasks ?? []}
        settings={
          settings ?? {
            name: dot.name,
            paused,
            researchAllowed: true,
            memoryAllowed: true,
          }
        }
        onOpenConversation={(id) => onOpenConversation?.(id)}
        onOpenComputer={() => {
          onRailChange(false);
          onComputer?.();
        }}
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
            aria-label="Save conversation as page"
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
            aria-label="Schedule a task in this conversation"
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
          ↑ {session.in} (input) ↓ {session.out} (output) Tokens · Coût estimé :
          ${session.cost.toFixed(4).replace('.', ',')}
        </span>
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {composerToolsOpen && (
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
            onClose={() => setComposerToolsOpen(false)}
          />
        )}
        <div className="chat-compose-row">
          <textarea
            aria-label="Message your Dot"
            placeholder={`Demander à ${dot.name}`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSubmitComposerOnKeyDown(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="chat-compose-tools">
            <button
              type="button"
              className={`icon-button ${composerToolsOpen ? 'active' : ''}`}
              aria-label="Ouvrir les outils du composer"
              title="Ajouter"
              aria-expanded={composerToolsOpen}
              onClick={() => setComposerToolsOpen((open) => !open)}
            >
              <Plus size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Add source page link"
              title="Ajouter une page web"
              onClick={() => setSourceOpen(!sourceOpen)}
            >
              <Link2 size={17} />
            </button>
            {models.providers.length > 0 && (
              <select
                className="model-select"
                aria-label="Model for this Dot"
                title="Modèle pour ce Dot"
                value={modelValue}
                onChange={async (e) => {
                  const parsed = parseModelKey(e.target.value);
                  setModelError('');
                  try {
                    await api(
                      `/dots/${dot.id}/model`,
                      'PUT',
                      parsed ?? { model: null },
                    );
                    onSaved();
                  } catch (err) {
                    setModelError(
                      err instanceof Error
                        ? err.message
                        : 'Could not change model.',
                    );
                  }
                }}
              >
                <option value="">
                  {defaultModelLabel
                    ? `Défaut (${defaultModelLabel})`
                    : 'Défaut'}
                </option>
                {models.providers.map((provider) => (
                  <optgroup
                    key={provider.id}
                    label={`${provider.label}${
                      provider.configured ? '' : ' (non configuré)'
                    }`}
                  >
                    {provider.models.map((id) => (
                      <option key={id} value={modelKey(provider.id, id)}>
                        {id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <button
              type="button"
              className={`icon-button reasoning-button ${
                reasoningEffort && reasoningEffort !== 'none' ? 'active' : ''
              }`}
              aria-label={`Réflexion : ${reasoningLabel}`}
              title={`Réflexion : ${reasoningLabel} — cliquez pour changer`}
              onClick={() => void cycleReasoning()}
              disabled={reasoningBusy}
            >
              <Brain size={17} />
            </button>
            {running && (
              <button
                type="button"
                className="send-button stop"
                aria-label="Stop response"
                title="Arrêter la réponse"
                onClick={() => copilotkit.stopAgent({ agent })}
              >
                <Square size={16} />
              </button>
            )}
            <button
              className="send-button"
              aria-label={running ? 'Queue message' : 'Send message'}
              title={running ? 'Mettre en file' : 'Envoyer'}
              disabled={!draft.trim() || !loaded || !contextReady || paused}
            >
              <ArrowUp size={19} />
            </button>
          </div>
        </div>
        <div className="chat-compose-note">
          {dot.name} · {selectedModel || 'défaut'}
          {paused ? ' · en pause' : ''}
        </div>
      </form>
      <InterventionStage
        open={stageOpen}
        onClose={() => setStageOpen(false)}
        dot={dot}
        messages={visible}
        events={activity}
        running={running}
        onStop={() => copilotkit.stopAgent({ agent })}
      />
    </div>
  );
}
