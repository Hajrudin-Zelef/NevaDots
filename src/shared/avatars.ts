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
    paused: 'robot-paused.webp',
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
