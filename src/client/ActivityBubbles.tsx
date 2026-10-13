import { useEffect, useRef, useState } from 'react';
import { activityVerb, type ActivityEvent } from '../shared/activity';
import type { Dot } from '../shared/types';
import { Mascot } from './Mascot';

const chipText = (event: ActivityEvent) => {
  const verb = activityVerb(event);
  return verb.length > 42 ? `${verb.slice(0, 42)}…` : verb;
};

const POSITION_KEY = 'nevadots-activity-bubble';

/**
 * Pop-pop avatar bubble. Shown while the activity rail is collapsed — most
 * notably when the browser pane takes over the width — so the Dot stays
 * visible and one click brings the full activity rail back.
 */
export function ActivityBubbles({
  events,
  running,
  dot,
  onOpen,
}: {
  events: ActivityEvent[];
  running: boolean;
  dot: Dot;
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
        x: Math.max(
          4,
          Math.min(window.innerWidth - 60, event.clientX - current.dx),
        ),
        y: Math.max(
          4,
          Math.min(window.innerHeight - 30, event.clientY - current.dy),
        ),
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

  const recent = events.slice(-3);
  const latest = events[events.length - 1];
  return (
    <div
      ref={container}
      className={`activity-bubbles ${running ? 'running' : ''} ${
        pos ? 'dragged' : ''
      }`}
      style={
        pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined
      }
    >
      {recent.length > 0 && (
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
      )}
      <button
        type="button"
        className={`activity-pill pop-pop ${running ? 'running' : ''}`}
        onPointerDown={startDrag}
        onClick={() => {
          if (moved.current) {
            moved.current = false;
            return;
          }
          onOpen();
        }}
        title="Glisser pour déplacer · cliquer pour ouvrir l’activité"
      >
        <span className="activity-avatar">
          <Mascot
            identity={dot.id}
            name={dot.name}
            avatar={dot.avatar}
            small
            animate
            state={running ? 'working' : 'idle'}
          />
        </span>
        <span className="activity-pill-text">
          {latest ? activityVerb(latest) : 'Prêt'}
        </span>
        {events.length > 0 && (
          <span className="activity-pill-count">{events.length}</span>
        )}
      </button>
    </div>
  );
}
