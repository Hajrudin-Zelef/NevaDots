/**
 * Motion preference — persisted UI setting (non-sensitive).
 *
 * Same pattern as theme.ts: localStorage with try/catch (private windows),
 * applied pre-paint via `data-motion` on <html> so the choice is effective
 * before the first render — no animation flash on load.
 *
 * Values: 'full' (default) | 'reduced' (essential motion only) | 'off'.
 * Secrets never belong here; this is a display preference, like the theme.
 */
export type MotionPreference = 'full' | 'reduced' | 'off';

const motionKey = 'nevadots-motion';

// The choice for this page, even if storage refuses to keep it.
let chosen: MotionPreference | undefined;

export function motionPreference(): MotionPreference {
  if (chosen) return chosen;
  try {
    const value = localStorage.getItem(motionKey);
    if (value === 'full' || value === 'reduced' || value === 'off') {
      return value;
    }
  } catch {
    // Fall through to full motion.
  }
  return 'full';
}

export function applyMotionPreference() {
  document.documentElement.dataset.motion = motionPreference();
}

export function setMotionPreference(preference: MotionPreference) {
  chosen = preference;
  try {
    if (preference === 'full') localStorage.removeItem(motionKey);
    else localStorage.setItem(motionKey, preference);
  } catch {
    // Applies for this visit only.
  }
  applyMotionPreference();
}
