import { openPageLink } from './page-navigation';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { CallReceipt } from '../shared/types';
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
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      onClick={(event) => {
        if (href?.startsWith('/#/spaces/')) {
          event.preventDefault();
          openPageLink(href);
        }
      }}
      href={href}
      target={href?.startsWith('/#/spaces/') ? undefined : '_blank'}
      rel="noreferrer"
    >
      {children}
    </a>
  ),
};

// Typewriter follower: the displayed cursor trails arrivals by ~260 ms so bursts
// (speculative decoding) flow instead of stuttering.
const SMOOTH_TAU_MS = 260;
const MIN_CHARS_PER_FRAME = 0.4;
// Adaptive re-parse cadence: never spend more than ~1/6 of the frame time parsing.
// Keeps big blocks from O(n^2) re-parsing (the source of streaming jank).
const MIN_RENDER_GAP_MS = 16;
const MAX_RENDER_GAP_MS = 500;

/**
 * Renders an assistant message. While `streaming`, text is revealed through a
 * time-based follower and Markdown is re-parsed at a cadence adapted to the last
 * parse cost. When the turn ends it renders the final text directly.
 */
export function StreamingMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const [rendered, setRendered] = useState(content);
  const contentRef = useRef(content);
  const targetLenRef = useRef(content.length);
  const shownRef = useRef(content.length);
  const lastShownRef = useRef(content.length);
  const scheduledAt = useRef(0);
  const renderCost = useRef(0);
  contentRef.current = content;
  targetLenRef.current = content.length;

  useLayoutEffect(() => {
    if (scheduledAt.current)
      renderCost.current = performance.now() - scheduledAt.current;
  });

  useEffect(() => {
    if (!streaming) {
      shownRef.current = contentRef.current.length;
      lastShownRef.current = contentRef.current.length;
      setRendered(contentRef.current);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      const target = targetLenRef.current;
      if (target < shownRef.current) {
        // New message or replay reset: snap.
        shownRef.current = target;
        lastShownRef.current = -1;
      }
      const remaining = target - shownRef.current;
      if (remaining > 0)
        shownRef.current = Math.min(
          target,
          shownRef.current +
            Math.max(MIN_CHARS_PER_FRAME, (remaining * dt) / SMOOTH_TAU_MS),
        );
      const shown = Math.floor(shownRef.current);
      const gap = Math.min(
        MAX_RENDER_GAP_MS,
        Math.max(MIN_RENDER_GAP_MS, renderCost.current * 6),
      );
      if (shown !== lastShownRef.current && now - scheduledAt.current >= gap) {
        lastShownRef.current = shown;
        scheduledAt.current = now;
        setRendered(contentRef.current.slice(0, shown));
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [streaming]);

  return (
    <>
      <ReactMarkdown components={markdownComponents}>
        {streaming ? rendered : content}
      </ReactMarkdown>
      {streaming && <span className="stream-caret" aria-hidden="true" />}
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
              {message.role === 'assistant' ? (
                <StreamingMarkdown
                  content={String(message.content)}
                  streaming={streaming && message.id === lastAssistantId}
                />
              ) : (
                <ReactMarkdown components={markdownComponents}>
                  {String(message.content)}
                </ReactMarkdown>
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
