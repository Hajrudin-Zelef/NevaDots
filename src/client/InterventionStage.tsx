import { Mascot } from './Mascot';
import { StreamingMarkdown } from './ChatTranscript';
import { activityVerb, type ActivityEvent } from '../shared/activity';
import { Minimize2, Square } from 'lucide-react';
import type { Message } from '@ag-ui/core';

/**
 * Full-screen "intervention" view: while a Dot works, this shows what it is
 * doing (latest activity), the answer as it streams, the avatar, and a stop
 * control — the NevaDots take on ajean's Jean stage.
 */
export function InterventionStage({
  open,
  onClose,
  dot,
  messages,
  events,
  running,
  onStop,
}: {
  open: boolean;
  onClose: () => void;
  dot: { id: string; name: string; avatar?: string | null };
  messages: Message[];
  events: ActivityEvent[];
  running: boolean;
  onStop: () => void;
}) {
  if (!open) return null;
  const lastAssistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.trim(),
    );
  const latest = events.at(-1);
  const caption = running
    ? latest
      ? `${activityVerb(latest)}${latest.detail ? ` · ${latest.detail}` : ''}`
      : 'réfléchit…'
    : 'prêt';
  return (
    <div className="intervention-stage" role="dialog" aria-label="Vue intervention">
      <header className="stage-header">
        <span className="stage-title">{dot.name}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Quitter la vue intervention"
          title="Quitter"
          onClick={onClose}
        >
          <Minimize2 size={18} />
        </button>
      </header>
      <div className="stage-body">
        <div className="stage-character">
          <Mascot
            avatar={dot.avatar}
            identity={dot.id}
            name={dot.name}
            state={running ? 'working' : 'idle'}
          />
          {running && (
            <span className="stage-orbit" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        <div className="stage-answer">
          {lastAssistant ? (
            <StreamingMarkdown
              content={String(lastAssistant.content)}
              streaming={running}
            />
          ) : (
            <p className="stage-empty">En attente de la prochaine réponse…</p>
          )}
        </div>
      </div>
      <footer className="stage-footer">
        <span className="stage-caption">
          {running && <span className="stage-pulse" aria-hidden="true" />}
          {caption}
        </span>
        {running && (
          <button type="button" className="stage-stop" onClick={onStop}>
            <Square size={14} />
            Arrêter
          </button>
        )}
      </footer>
    </div>
  );
}
