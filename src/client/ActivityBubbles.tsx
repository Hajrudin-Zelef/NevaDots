import { useEffect, useRef, useState } from 'react';
import { activityVerb, type ActivityEvent } from '../shared/activity';

const chipText = (event: ActivityEvent) => {
  const verb = activityVerb(event);
  return verb.length > 42 ? `${verb.slice(0, 42)}…` : verb;
};

const POSITION_KEY = 'nevadots-activity-bubble';

/** Floating activity bubbles shown while the right rail is collapsed. */
export function ActivityBubbles({
  events,
  running,
  onOpen,
}: {
  events: ActivityEvent[];
  running: boolean;
  onOpen: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(POSITION_KEY);
      if (raw) setPos(JSON.parse(raw) as { x: number; y: number });
    } catch {
      /* ignore a corrupt stored position */
    }
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      current.moved = true;
      setPos({
        x: Math.max(4, Math.min(window.innerWidth - 60, event.clientX - current.dx)),
        y: Math.max(4, Math.min(window.innerHeight - 30, event.clientY - current.dy)),
      });
    };
    const onUp = () => {
      const current = drag.current;
      if (!current) return;
      moved.current = current.moved;
      if (current.moved)
        setPos((value) => {
          if (value) {
            try {
              localStorage.setItem(POSITION_KEY, JSON.stringify(value));
            } catch {
              /* ignore quota errors */
            }
          }
          return value;
        });
      drag.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const startDrag = (event: React.PointerEvent) => {
    const node = container.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    drag.current = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      moved: false,
    };
    moved.current = false;
    setPos({ x: rect.left, y: rect.top });
  };

  if (!events.length) return null;
  const recent = events.slice(-3);
  const latest = events[events.length - 1];
  return (
    <div
      ref={container}
      className={`activity-bubbles ${running ? 'running' : ''} ${
        pos ? 'dragged' : ''
      }`}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div className="activity-chips">
        {recent.map((event) => (
          <button
            key={event.id}
            type="button"
            className={`activity-chip ${event.status}`}
            onClick={onOpen}
            title="Voir toute l’activité"
          >
            {chipText(event)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`activity-pill ${running ? 'running' : ''}`}
        onPointerDown={startDrag}
        onClick={() => {
          if (moved.current) {
            moved.current = false;
            return;
          }
          onOpen();
        }}
        title="Glisser pour déplacer · cliquer pour ouvrir"
      >
        <span className="activity-pill-dot" />
        <span className="activity-pill-text">{activityVerb(latest)}</span>
        <span className="activity-pill-count">{events.length}</span>
      </button>
    </div>
  );
}
