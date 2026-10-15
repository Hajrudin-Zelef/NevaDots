import {
  AVATAR_QUALITY_SETTINGS,
  DEFAULT_AVATAR,
  DEFAULT_AVATAR_QUALITY,
  DEFAULT_AVATAR_QUALITY_SETTING,
  avatarSrc,
  type AvatarQuality,
  type AvatarQualitySetting,
} from '../shared/avatars';
import { api } from './api';

/**
 * Avatar animation quality preference. Stored server-side (`app_config`) and
 * cached in localStorage so the avatar can pick a tier at first paint without
 * waiting for a round-trip. `auto` resolves a concrete tier from the network
 * (Network Information API), the device (CPU/memory) and reduced-motion.
 */

const STORAGE_KEY = 'opendots-avatar-quality';

/** Dispatched on `window` whenever the resolved tier changes. */
export const AVATAR_QUALITY_EVENT = 'avatar-quality-changed';

type ConnectionLike = {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  addEventListener?: (type: string, listener: () => void) => void;
};

function connection(): ConnectionLike | undefined {
  return (navigator as unknown as { connection?: ConnectionLike }).connection;
}

function deviceMemory(): number | undefined {
  return (navigator as unknown as { deviceMemory?: number }).deviceMemory;
}

function isSetting(value: unknown): value is AvatarQualitySetting {
  return (
    typeof value === 'string' &&
    (AVATAR_QUALITY_SETTINGS as readonly string[]).includes(value)
  );
}

let setting: AvatarQualitySetting = DEFAULT_AVATAR_QUALITY_SETTING;
let resolved: AvatarQuality = DEFAULT_AVATAR_QUALITY;

/** Pick a tier from connection + device + motion preferences. */
export function autoAvatarQuality(): AvatarQuality {
  if (typeof window === 'undefined') return DEFAULT_AVATAR_QUALITY;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    return 'low';

  const conn = connection();
  if (conn?.saveData) return 'low';

  let quality: AvatarQuality = DEFAULT_AVATAR_QUALITY;
  const type = conn?.effectiveType;
  const downlink = conn?.downlink;
  if (type === 'slow-2g' || type === '2g') quality = 'low';
  else if (type === '3g') quality = 'standard';
  else if (type === '4g' || (typeof downlink === 'number' && downlink >= 2.5))
    quality = 'high';

  // A weak device would jank on the heaviest clip: cap at standard.
  const cores = navigator.hardwareConcurrency;
  const memory = deviceMemory();
  const weakDevice =
    (typeof cores === 'number' && cores > 0 && cores <= 4) ||
    (typeof memory === 'number' && memory > 0 && memory <= 4);
  if (weakDevice && quality === 'high') quality = 'standard';

  return quality;
}

/** Warm the default avatar's idle clip for the resolved tier (best effort). */
function preloadIdle() {
  if (typeof Image === 'undefined') return;
  const src = avatarSrc(DEFAULT_AVATAR, resolved);
  if (!src) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
}

function recompute(dispatch: boolean) {
  resolved = setting === 'auto' ? autoAvatarQuality() : setting;
  preloadIdle();
  if (dispatch && typeof window !== 'undefined')
    window.dispatchEvent(new Event(AVATAR_QUALITY_EVENT));
}

/** The stored preference (`auto` by default). */
export function getAvatarQualitySetting(): AvatarQualitySetting {
  return setting;
}

/** The concrete tier currently in use. */
export function getAvatarQuality(): AvatarQuality {
  return resolved;
}

/** Apply a preference locally (no server write) and recompute the tier. */
export function applyAvatarQualitySetting(
  value: AvatarQualitySetting,
  dispatch = true,
) {
  setting = value;
  recompute(dispatch);
}

/** Apply + persist locally, then notify listeners. */
export function setAvatarQualitySetting(value: AvatarQualitySetting) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode */
  }
  applyAvatarQualitySetting(value);
}

/** Load the cached preference and re-evaluate on network changes. */
export function initAvatarQuality() {
  let initial: AvatarQualitySetting = DEFAULT_AVATAR_QUALITY_SETTING;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (isSetting(cached)) initial = cached;
  } catch {
    /* ignore */
  }
  applyAvatarQualitySetting(initial, false);

  if (typeof window !== 'undefined') {
    const reevaluate = () => {
      if (setting === 'auto') recompute(true);
    };
    connection()?.addEventListener?.('change', reevaluate);
    window.addEventListener('online', reevaluate);
  }

  // Reconcile with the server (best effort; the cache already painted).
  void fetchAvatarQuality().catch(() => {});
}

/** Fetch the persisted preference from the server and apply it. */
export async function fetchAvatarQuality(): Promise<AvatarQualitySetting> {
  const result = await api<{ quality: AvatarQualitySetting }>(
    '/avatar-quality',
  );
  if (isSetting(result.quality)) setAvatarQualitySetting(result.quality);
  return result.quality;
}

/** Persist the preference locally and on the server. */
export async function saveAvatarQuality(value: AvatarQualitySetting) {
  setAvatarQualitySetting(value);
  await api('/avatar-quality', 'PUT', { quality: value });
}
