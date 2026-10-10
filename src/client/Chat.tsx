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
import { useEffect, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import { ReasoningPanel } from './ReasoningPanel';
import type { ReasoningRunStats } from '../server/reasoning.js';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';

export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
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
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
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
          .then((stats) => setReasonStats(stats))
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
        if (!cancelled) setReasonStats(stats);
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
    void api<{ translation: string }>('/translate', 'POST', {
      text: reasonPanelText.slice(0, 12000),
      targetLang: 'fr',
    })
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
  const [models, setModels] = useState<{
    default: string | null;
    models: string[];
  }>({ default: null, models: [] });
  const [modelError, setModelError] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ default: string | null; models: string[] }>('/models')
      .then((value) => {
        if (active) setModels(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const selectedModel = dot.model ?? models.default ?? '';
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => setError(error.message),
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => setError(event.message),
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
  const send = async (text: string) => {
    if (!text.trim() || running || !loaded || !contextReady || paused) return;
    setError('');
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
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        throw new Error(
          'The current turn returned no response. Check the runtime connection and retry.',
        );
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
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
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          render3d
          state={mascotState}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
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
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
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
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
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
        />
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
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          {models.models.length > 0 && (
            <select
              className="model-select"
              aria-label="Model for this Dot"
              title="Model for this Dot"
              value={selectedModel}
              onChange={async (e) => {
                const value = e.target.value;
                setModelError('');
                try {
                  await api(`/dots/${dot.id}/model`, 'PUT', {
                    model: value || null,
                  });
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
                {models.default ? `Default (${models.default})` : 'Default'}
              </option>
              {models.models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
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
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => copilotkit.stopAgent({ agent })}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={!draft.trim() || !loaded || !contextReady || paused}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'}
        </div>
      </form>
    </div>
  );
}
