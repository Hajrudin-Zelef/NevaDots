import { openPageLink } from './page-navigation';
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FileText, PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { CallReceipt } from '../shared/types';
import { formatChars, parseUserMessageWithAttachments } from './attachments';
import { safeHref } from './safe-href';
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

// Stable component map so ReactMarkdown does not re-parse on every parent render.
const markdownComponents = {
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const safe = safeHref(href);
    if (safe === null) return <span>{children}</span>;
    const internal = safe.startsWith('/#/spaces/');
    return (
      <a
        onClick={(event) => {
          if (internal) {
            event.preventDefault();
            openPageLink(safe);
          }
        }}
        href={safe}
        target={internal ? undefined : '_blank'}
        rel="noreferrer"
      >
        {children}
      </a>
    );
  },
};

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
    <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
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
      <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
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
      {parts.attachments.map((attachment, index) => (
        <details key={index} className="chat-attachment-chip">
          <summary>
            <FileText size={13} />
            <span>{attachment.name}</span>
            <span className="muted">
              · {formatChars(attachment.chars)}
              {attachment.truncated ? ' · tronqué' : ''}
            </span>
          </summary>
          <pre>{attachment.body}</pre>
        </details>
      ))}
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
}: {
  messages: Message[];
  calls: CallReceipt[];
  renderTools?: (message: AssistantMessage) => ReactNode;
  reasoningForMessage?: (message: Message) => string | undefined;
  onOpenReasoning?: (reasoningId: string) => void;
  streaming?: boolean;
}) {
  const ids = new Set(messages.map((message) => message.id));
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')?.id;
  return (
    <>
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
    </>
  );
}
