import { useEffect, useState } from 'react';
import {
  Brain,
  CalendarClock,
  Check,
  FileText,
  Globe,
  Keyboard,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  activityVerb,
  type ActivityEvent,
  type ActivityKind,
} from '../shared/activity';
import { api } from './api';
import { ThinkingOrb, orbKindForActivityKind } from './ThinkingOrb';
import type { Conversation } from '../shared/types';

const kindIcons: Record<ActivityKind, LucideIcon> = {
  command: Terminal,
  typing: Keyboard,
  web: Globe,
  file: FileText,
  search: Search,
  tool: Wrench,
  reasoning: Brain,
  task: CalendarClock,
};

const statusLabel: Record<ActivityEvent['status'], string> = {
  running: 'en cours',
  ok: 'fait',
  error: 'erreur',
  stopped: 'arrêté',
};

/**
 * Ultra-detailed activity modal (Muse style): left pane is the step timeline,
 * right pane is the full detail of the selected step. The current thread's
 * steps come live from the run; any other conversation is fetched on open.
 */
export function ActivityDetailModal({
  conversation,
  liveEvents,
  isCurrent,
  running,
  onClose,
  onOpenConversation,
}: {
  conversation: Conversation;
  liveEvents: ActivityEvent[];
  isCurrent: boolean;
  running: boolean;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(
    isCurrent ? liveEvents : null,
  );
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (isCurrent) {
      setEvents(liveEvents);
      return;
    }
    let active = true;
    setEvents(null);
    void api<{ events: ActivityEvent[] }>(
      `/conversations/${encodeURIComponent(conversation.id)}/activity`,
    )
      .then((value) => {
        if (active) setEvents(value.events);
      })
      .catch(() => {
        if (active) setEvents([]);
      });
    return () => {
      active = false;
    };
  }, [conversation.id, isCurrent, liveEvents]);

  useEffect(() => {
    if (events && events.length) setSelected(events.length - 1);
  }, [events]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = events ?? [];
  const current = list[selected];
  const CurrentIcon = current ? kindIcons[current.kind] : Wrench;
  const live = isCurrent && running;
  const done = !live;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="ad-modal"
        role="dialog"
        aria-modal="true"
        aria-label={conversation.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ad-head">
          <span className={`ad-chip ${done ? 'done' : 'live'}`}>
            {done ? 'Terminé' : 'En cours'}
          </span>

          <h2 className="ad-title">{conversation.title}</h2>
          <button
            type="button"
            className="ad-close icon-button"
            aria-label="Fermer"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="ad-body">
          <div className="ad-timeline">
            {events === null ? (
              <p className="ad-empty">
                <ThinkingOrb kind="loading" /> Chargement…
              </p>
            ) : list.length === 0 ? (
              <p className="ad-empty">Aucune action enregistrée.</p>
            ) : (
              <ol className="ad-steps">
                {list.map((item, index) => {
                  const Icon = kindIcons[item.kind];
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`ad-step ${item.status} ${
                          index === selected ? 'selected' : ''
                        }`}
                        onClick={() => setSelected(index)}
                      >
                        <span className="ad-step-icon">
                          <Icon size={14} />
                        </span>
                        <span className="ad-step-text">
                          {item.kind === 'reasoning'
                            ? item.label
                            : activityVerb(item)}
                        </span>
                        <span className={`ad-step-state ${item.status}`}>
                          {item.status === 'running' ? (
                            <ThinkingOrb
                              kind={orbKindForActivityKind(item.kind)}
                            />
                          ) : item.status === 'ok' ? (
                            <Check size={12} />
                          ) : (
                            statusLabel[item.status]
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <div className="ad-detail">
            {current ? (
              <>
                <div className="ad-detail-head">
                  <span className={`ad-step-icon big ${current.status}`}>
                    <CurrentIcon size={16} />
                  </span>
                  <h3>
                    {current.kind === 'reasoning'
                      ? current.label
                      : activityVerb(current)}
                  </h3>
                </div>
                {current.detail && (
                  <p className="ad-detail-sub">{current.detail}</p>
                )}
                {current.error && (
                  <pre className="ad-result error">{current.error}</pre>
                )}
                {current.result && (
                  <>
                    <h4>Résultat</h4>
                    <pre className="ad-result">{current.result}</pre>
                  </>
                )}
                {!current.detail && !current.result && !current.error && (
                  <p className="ad-empty">Pas de détail pour cette étape.</p>
                )}
              </>
            ) : (
              <p className="ad-empty">Sélectionne une étape.</p>
            )}
          </div>
        </div>
        <footer className="ad-foot">
          <button
            type="button"
            className="ad-open"
            onClick={() => onOpenConversation(conversation.id)}
          >
            Ouvrir la conversation
          </button>
        </footer>
      </section>
    </div>
  );
}
