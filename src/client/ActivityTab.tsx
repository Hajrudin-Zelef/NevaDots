import type { Dot } from '../shared/types';
import { Mascot } from './Mascot';

/**
 * Collapsed representation of the activity rail: a small avatar-only tab at
 * the top centre of the conversation. Clicking it brings the rail back on the
 * right. Replaces the previous floating pill/chips.
 */
export function ActivityTab({
  dot,
  running,
  onOpen,
}: {
  dot: Dot;
  running: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`activity-tab ${running ? 'running' : ''}`}
      onClick={onOpen}
      aria-label="Ouvrir l’activité"
      title="Ouvrir l’activité"
    >
      <Mascot
        name={dot.name}
        avatar={dot.avatar}
        small
        animate
        state={running ? 'working' : 'idle'}
      />
    </button>
  );
}
