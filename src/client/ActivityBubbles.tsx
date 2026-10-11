import { activityVerb, type ActivityEvent } from './activity';

const chipText = (event: ActivityEvent) => {
  const verb = activityVerb(event);
  return verb.length > 42 ? `${verb.slice(0, 42)}…` : verb;
};

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
  if (!events.length) return null;
  const recent = events.slice(-3);
  const latest = events[events.length - 1];
  return (
    <div className={`activity-bubbles ${running ? 'running' : ''}`}>
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
        onClick={onOpen}
        title="Voir toute l’activité"
      >
        <span className="activity-pill-dot" />
        <span className="activity-pill-text">{activityVerb(latest)}</span>
        <span className="activity-pill-count">{events.length}</span>
      </button>
    </div>
  );
}
