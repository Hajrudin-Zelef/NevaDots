import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CornerUpLeft, FileText, PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { CallReceipt } from '../shared/types';
import {
  fileExtension,
  formatChars,
  parseUserMessageWithAttachments,
} from './attachments';
import { markdownComponents } from './markdown-components';
import { MessageActions, type SpeechTtsSettings } from './MessageActions';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { isScheduledTaskMessage } from '../shared/scheduled-message';

// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'user' &&
    (message.id.startsWith(voiceReceiptMessagePrefix) ||
      (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'voice_receipt'))
  );
}

// Time-based follower: the revealed cursor trails arrivals by ~150 ms so bursts
// flow instead of stuttering. Rendering is plain text while streaming (cheap),
// so this can run every frame without the old adaptive re-parse throttle.
const SMOOTH_TAU_MS = 150;
const MIN_CHARS_PER_FRAME = 0.4;
// A word stays an animated span for this long, then settles into plain text.
const TOKEN_FADE_MS = 340;
// Above this length, skip per-word spans (plain text) to stay smooth on weak
// hardware and very long messages.
const MAX_ANIMATED_CHARS = 6000;

/**
 * Markdown for a settled message, memoized so a streaming token elsewhere does
 * not re-parse the whole transcript's Markdown on every frame.
 */
const StaticMarkdown = memo(function StaticMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

/**
 * Renders an assistant message. While `streaming`, the text is revealed through
 * a time-based follower and rendered as plain text (no Markdown re-parse); each
 * freshly-revealed word fades in (accent → final colour). When the turn ends it
 * renders the final Markdown.
 */
export function StreamingMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const contentRef = useRef(content);
  const targetLenRef = useRef(content.length);
  const shownRef = useRef(content.length);
  const [view, setView] = useState(() => ({
    shown: content.length,
    settled: content.length,
  }));
  contentRef.current = content;
  targetLenRef.current = content.length;

  useEffect(() => {
    if (!streaming) {
      shownRef.current = contentRef.current.length;
      setView({
        shown: contentRef.current.length,
        settled: contentRef.current.length,
      });
      return;
    }
    let frame = 0;
    let last = performance.now();
    // (time, revealedLength) so `settled` can trail `shown` by TOKEN_FADE_MS.
    const history: { t: number; len: number }[] = [];
    const loop = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      const target = targetLenRef.current;
      if (target < shownRef.current) shownRef.current = target;
      const remaining = target - shownRef.current;
      if (remaining > 0)
        shownRef.current = Math.min(
          target,
          shownRef.current +
            Math.max(MIN_CHARS_PER_FRAME, (remaining * dt) / SMOOTH_TAU_MS),
        );
      const shown = Math.floor(shownRef.current);
      history.push({ t: now, len: shown });
      while (history.length > 2 && now - history[0].t > TOKEN_FADE_MS)
        history.shift();
      const settled = history[0].len;
      setView((prev) =>
        prev.shown === shown && prev.settled === settled
          ? prev
          : { shown, settled },
      );
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [streaming]);

  if (!streaming)
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    );

  const shown = Math.min(view.shown, content.length);
  // Snap the settled boundary down to a word boundary so animated spans are
  // whole words (a word only leaves the animated tail once its fade is done).
  let settled = Math.min(view.settled, shown);
  const snap = content.lastIndexOf(' ', settled);
  if (snap > 0 && snap < settled) settled = snap + 1;

  const head = content.slice(0, settled);
  const tail = content.slice(settled, shown);
  const animate = content.length <= MAX_ANIMATED_CHARS;

  let offset = settled;
  return (
    <span className="stream-text">
      {head}
      {animate &&
        tail.split(/(\s+)/).map((token) => {
          const key = offset;
          offset += token.length;
          return token === '' ? null : (
            <span key={key} className="tok">
              {token}
            </span>
          );
        })}
      {!animate && tail}
      <span className="stream-caret" aria-hidden="true" />
    </span>
  );
}

/**
 * Bulle utilisateur : les blocs de contenu de pièces jointes injectés
 * ([Fichier : nom — N car.]) sont repliés en puces dépliables ; le modèle
 * garde le texte intégral, l'utilisateur ne voit que le brouillon + chips.
 * Sans bloc : rendu Markdown inchangé.
 */
export function UserMessageContent({ content }: { content: string }) {
  const parts = useMemo(
    () => parseUserMessageWithAttachments(content),
    [content],
  );
  if (!parts.attachments.length) return <StaticMarkdown content={content} />;
  return (
    <>
      {parts.text && <StaticMarkdown content={parts.text} />}
      {parts.attachments.map((attachment, index) => {
        const ext = fileExtension(attachment.name);
        return (
          <details key={index} className="chat-attachment-chip">
            <summary>
              <FileText size={13} />
              <span>{attachment.name}</span>
              {ext && <span className="file-ext">{ext}</span>}
              <span className="muted">
                · {formatChars(attachment.chars)}
                {attachment.truncated ? ' · tronqué' : ''}
              </span>
            </summary>
            <pre>{attachment.body}</pre>
          </details>
        );
      })}
    </>
  );
}

function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
export function ChatTranscript({
  messages,
  calls,
  renderTools,
  reasoningForMessage,
  onOpenReasoning,
  streaming = false,
  running = false,
  onRetry,
  threadId,
  dotId,
  model,
  tts,
  onQuote,
}: {
  messages: Message[];
  calls: CallReceipt[];
  renderTools?: (message: AssistantMessage) => ReactNode;
  reasoningForMessage?: (message: Message) => string | undefined;
  onOpenReasoning?: (reasoningId: string) => void;
  streaming?: boolean;
  /** Tour en cours (désactive « Régénérer »). */
  running?: boolean;
  /** Régénère la dernière réponse (tronque au dernier message user). */
  onRetry?: () => void;
  /** Contexte joint aux votes (volet Feedback). */
  threadId?: string;
  dotId?: string;
  model?: string;
  /** Réglages voix pour la lecture (Réglages globaux). */
  tts?: SpeechTtsSettings;
  /** Cite la sélection (« Répondre ») comme contexte du prochain message. */
  onQuote?: (text: string) => void;
}) {
  const ids = new Set(messages.map((message) => message.id));
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')?.id;
  const [quote, setQuote] = useState<{
    x: number;
    y: number;
    below: boolean;
    text: string;
    from: 'assistant' | 'user';
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!quote) return;
    const hide = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node | null))
        setQuote(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQuote(null);
    };
    const scroll = () => setQuote(null);
    // Désélection (clic qui effondre la sélection, Ctrl+A relâché, etc.) :
    // sans ça le volet « Répondre » reste affiché après désélection (F2).
    const deselect = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) setQuote(null);
    };
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('selectionchange', deselect);
    return () => {
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('selectionchange', deselect);
    };
  }, [quote]);
  const onSelect = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuote(null);
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 3 || text.length > 2000) {
      setQuote(null);
      return;
    }
    const anchor = selection.anchorNode;
    const element =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? undefined);
    // Toute bulle (assistant comme user) : citer son propre message pour
    // préciser sert autant que citer la réponse.
    const bubble = element?.closest?.('.chat-bubble');
    if (!bubble) {
      setQuote(null);
      return;
    }
    const from = bubble.classList.contains('user') ? 'user' : 'assistant';
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const below = rect.top < 80;
    setQuote({
      x: Math.min(
        Math.max(rect.left + rect.width / 2, 120),
        window.innerWidth - 120,
      ),
      y: below ? rect.bottom : Math.max(rect.top, 8),
      below,
      text,
      from,
    });
  };
  return (
    <div className="chat-transcript" onMouseUp={onSelect}>
      {quote && (
        <div
          ref={toolbarRef}
          className="quote-toolbar"
          role="toolbar"
          aria-label="Citer la sélection"
          style={{
            left: quote.x,
            top: quote.y,
            transform: quote.below
              ? 'translate(-50%, 8px)'
              : 'translate(-50%, -100%)',
          }}
        >
          <button
            type="button"
            className="quote-reply"
            title={
              quote.from === 'user'
                ? 'Reprendre ce passage dans ton message'
                : 'Citer ce passage dans ta réponse'
            }
            onClick={() => {
              onQuote?.(quote.text);
              window.getSelection()?.removeAllRanges();
              setQuote(null);
            }}
          >
            <CornerUpLeft size={13} />
            Répondre
          </button>
        </div>
      )}
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message) => (
        <Fragment key={message.id}>
          {typeof message.content === 'string' && message.content.trim() && (
            <div
              className={`chat-bubble ${message.role}${isScheduledTaskMessage(message) ? ' scheduled' : ''}`}
            >
              {message.role === 'assistant' &&
                reasoningForMessage &&
                onOpenReasoning &&
                (() => {
                  const reasoningId = reasoningForMessage(message);
                  return reasoningId ? (
                    <button
                      type="button"
                      className="reasoning-link"
                      onClick={() => onOpenReasoning(reasoningId)}
                    >
                      Raisonnement
                    </button>
                  ) : null;
                })()}
              {isScheduledTaskMessage(message) && (
                <span className="scheduled-message-label">Scheduled</span>
              )}
              {message.role === 'user' ? (
                <UserMessageContent content={String(message.content)} />
              ) : message.role === 'assistant' &&
                streaming &&
                message.id === lastAssistantId ? (
                <StreamingMarkdown
                  content={String(message.content)}
                  streaming
                />
              ) : (
                <StaticMarkdown content={String(message.content)} />
              )}
              {message.role === 'assistant' &&
                typeof message.content === 'string' && (
                  <MessageActions
                    messageId={message.id}
                    text={message.content}
                    isLast={message.id === lastAssistantId}
                    running={running}
                    onRetry={() => onRetry?.()}
                    threadId={threadId}
                    dotId={dotId}
                    model={model}
                    tts={tts}
                  />
                )}
            </div>
          )}
          {message.role === 'assistant' && renderTools?.(message)}
          {calls
            .filter((call) => call.anchorMessageId === message.id)
            .map((call) => (
              <Receipt key={call.id} call={call} />
            ))}
        </Fragment>
      ))}
    </div>
  );
}
