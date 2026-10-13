/**
 * Single source of truth for Dot avatars, shared by client and server.
 *
 * The avatar stored on a Dot is a bare id (see `Dot.avatar`). The extension
 * lives here, so an avatar may be a still PNG or an animated WebP. Server code
 * imports this file with a `.js` suffix (node16 build); client code may omit it.
 */
export const AVATAR_IDS = [
  'blue',
  'pink',
  'green',
  'mint',
  'orange',
  'purple',
  'robot',
  'robot-blue',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

/** id → file in `public/dots/` (served at `/dots/<file>`). */
export const AVATAR_FILES: Record<AvatarId, string> = {
  blue: 'blue.png',
  pink: 'pink.png',
  green: 'green.png',
  mint: 'mint.png',
  orange: 'orange.png',
  purple: 'purple.png',
  robot: 'robot.webp',
  // Blue robot has no idle clip yet; its resting pose doubles as the base.
  'robot-blue': 'robot-blue-complete.webp',
};

/** Public URL for an avatar id, or `null` when the id is unknown. */
export function avatarSrc(id: string | null | undefined): string | null {
  if (!id || !(id in AVATAR_FILES)) return null;
  return `/dots/${AVATAR_FILES[id as AvatarId]}`;
}

/**
 * Optional per-state animation clips, keyed by the app's mascot state. Only
 * avatars listed here switch clips; missing states fall back to the base file
 * (see `avatarStateSrc`). Files live in `public/dots/`.
 */
export const AVATAR_STATE_FILES: Partial<Record<AvatarId, Record<string, string>>> = {
  robot: {
    listening: 'robot-listening.webp',
    thinking: 'robot-thinking.webp',
    analyzing: 'robot-analyzing.webp',
    searching: 'robot-searching.webp',
    working: 'robot-working.webp',
    writing: 'robot-writing.webp',
    complete: 'robot-complete.webp',
    error: 'robot-error.webp',
    paused: 'robot-paused.webp',
  },
  // LEO's blue robot only ships a subset of clips; the missing states alias the
  // nearest available blue pose so the color never flicks to another avatar.
  // `listening` is a temporary alias until the real clip is re-exported.
  'robot-blue': {
    listening: 'robot-blue-thinking.webp',
    thinking: 'robot-blue-thinking.webp',
    analyzing: 'robot-blue-thinking.webp',
    searching: 'robot-blue-searching.webp',
    writing: 'robot-blue-writing.webp',
    working: 'robot-blue-writing.webp',
    complete: 'robot-blue-complete.webp',
    error: 'robot-blue-error.webp',
    paused: 'robot-blue-complete.webp',
  },
};

/** URL of the state-specific clip, or `null` to fall back to the base avatar. */
export function avatarStateSrc(
  id: string | null | undefined,
  state: string,
): string | null {
  if (!id) return null;
  const file = AVATAR_STATE_FILES[id as AvatarId]?.[state];
  return file ? `/dots/${file}` : null;
}

/** Every state-clip URL declared for an avatar (for idle-time preloading). */
export function avatarStateFiles(id: string | null | undefined): string[] {
  if (!id) return [];
  const map = AVATAR_STATE_FILES[id as AvatarId];
  return map ? Object.values(map).map((file) => `/dots/${file}`) : [];
}
