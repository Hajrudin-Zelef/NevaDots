import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  FileText,
  Globe,
  Keyboard,
  Monitor,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  type ActivityEvent,
  type ActivityKind,
} from './activity';

const icons: Record<ActivityKind, LucideIcon> = {
  command: Terminal,
  typing: Keyboard,
  web: Globe,
  file: FileText,
  search: Search,
  tool: Wrench,
  reasoning: Brain,
  task: CalendarClock,
};

const filters: { id: string; label: string; kinds: ActivityKind[] }[] = [
  { id: 'all', label: 'Tout', kinds: [] },
  { id: 'web', label: 'Web', kinds: ['web', 'search'] },
  { id: 'files', label: 'Fichiers', kinds: ['file'] },
  { id: 'commands', label: 'Commandes', kinds: ['command', 'typing'] },
];

function StatusChip({ status }: { status: ActivityEvent['status'] }) {
  if (status === 'running')
    return <span className="activity-status running">en cours</span>;
  if (status === 'error')
    return <span className="activity-status error">erreur</span>;
  if (status === 'stopped')
    return <span className="activity-status stopped">arrêté</span>;
  return (
    <span className="activity-status ok">
      <Check size={11} /> fait
    </span>
  );
}

export function ActivityRail({
  open,
  events,
  running,
  dotName,
  onClose,
  onOpenReasoning,
  onOpenComputer,
}: {
  open: boolean;
  events: ActivityEvent[];
  running: boolean;
  dotName: string;
  onClose: () => void;
  onOpenReasoning?: (id: string) => void;
  onOpenComputer?: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length, running, open]);
  const shown = useMemo(() => {
    const active = filters.find((item) => item.id === filter);
    if (!active || !active.kinds.length) return events;
    return events.filter((event) => active.kinds.includes(event.kind));
  }, [events, filter]);
  if (!open) return null;
  const toggle = (event: ActivityEvent) => {
    if (event.kind === 'reasoning' && onOpenReasoning) {
      onOpenReasoning(event.id);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(event.id)) next.delete(event.id);
      else next.add(event.id);
      return next;
    });
  };
  return (
    <aside className="activity-overlay" aria-label="Activité de l’agent">
      <div className="activity-rail">
        <header className="activity-header">
          <div>
            <strong>Activité</strong>
            {running && <span className="activity-live">● en cours</span>}
          </div>
          <div className="activity-header-actions">
            {onOpenComputer && (
              <button
                type="button"
                className="icon-button"
                aria-label="Ouvrir l’ordinateur"
                title="Ouvrir l’ordinateur"
                onClick={onOpenComputer}
              >
                <Monitor size={16} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Fermer le panneau d’activité"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="activity-filters" role="tablist">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="activity-log" ref={logRef} role="log">
          {!shown.length && (
            <p className="activity-empty">
              L’activité de {dotName} apparaîtra ici : commandes, sites visités,
              fichiers, recherches.
            </p>
          )}
          {shown.map((event) => {
            const Icon = icons[event.kind];
            const isOpen = expanded.has(event.id);
            return (
              <div
                key={event.id}
                className={`activity-event ${event.status} ${isOpen ? 'expanded' : ''}`}
              >
                <button
                  type="button"
                  className="activity-event-head"
                  onClick={() => toggle(event)}
                >
                  <span className="activity-icon">
                    <Icon size={14} />
                  </span>
                  <span className="activity-text">
                    <span className="activity-label">{event.label}</span>
                    {event.detail && (
                      <span className="activity-detail" title={event.detail}>
                        {event.detail}
                      </span>
                    )}
                  </span>
                  <StatusChip status={event.status} />
                  {(event.result || event.kind === 'reasoning') && (
                    <ChevronRight
                      size={14}
                      className="activity-chevron"
                      aria-hidden="true"
                    />
                  )}
                </button>
                {isOpen && (event.result || event.error) && (
                  <pre className="activity-result">
                    {event.error || event.result}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
