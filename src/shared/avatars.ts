/**
 * Single source of truth for Dot avatars, shared by client and server.
 *
 * The avatar stored on a Dot is a bare id (see `Dot.avatar`). The extension
 * lives here, so an avatar may be a still PNG or an animated WebP. Server code
 * imports this file with a `.js` suffix (node16 build); client code may omit it.
 *
 * Assets are grouped by family under `public/dots/` (served at `/dots/<path>`):
 *   classic/  the original 6 still PNG avatars
 *   robot/    the green (`robot`) and blue (`robot-blue`) animated robots
 *   sam/      NevaDots Dot "Sam" (animated, full set of state aliases)
 *   leo/      NevaDots Dot "Leo" (still base for now; clips to come)
 *   aline/    NevaDots Dot "Aline" (still base for now; clips to come)
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
  'sam',
  'leo',
  'aline',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

/** id → file under `public/dots/` (served at `/dots/<file>`). */
export const AVATAR_FILES: Record<AvatarId, string> = {
  blue: 'classic/blue.png',
  pink: 'classic/pink.png',
  green: 'classic/green.png',
  mint: 'classic/mint.png',
  orange: 'classic/orange.png',
  purple: 'classic/purple.png',
  robot: 'robot/robot.webp',
  // Blue robot has no idle clip yet; its resting pose doubles as the base.
  'robot-blue': 'robot/robot-blue-complete.webp',
  // NevaDots Dots. Sam ships a full animated set; Leo/Aline are still bases.
  sam: 'sam/idle.webp',
  leo: 'leo/idle.png',
  aline: 'aline/idle.png',
};

/** Public URL for an avatar id, or `null` when the id is unknown. */
export function avatarSrc(id: string | null | undefined): string | null {
  if (!id || !(id in AVATAR_FILES)) return null;
  return `/dots/${AVATAR_FILES[id as AvatarId]}`;
}

/**
 * Optional per-state animation clips, keyed by the app's mascot state. Only
 * avatars listed here switch clips; missing states fall back to the base file
 * (see `avatarStateSrc`). Files live under `public/dots/`.
 */
export const AVATAR_STATE_FILES: Partial<
  Record<AvatarId, Record<string, string>>
> = {
  robot: {
    listening: 'robot/robot-listening.webp',
    thinking: 'robot/robot-thinking.webp',
    analyzing: 'robot/robot-analyzing.webp',
    searching: 'robot/robot-searching.webp',
    working: 'robot/robot-working.webp',
    writing: 'robot/robot-writing.webp',
    complete: 'robot/robot-complete.webp',
    error: 'robot/robot-error.webp',
    paused: 'robot/robot-paused.webp',
  },
  // LEO's blue robot only ships a subset of clips; the missing states alias the
  // nearest available blue pose so the color never flicks to another avatar.
  // `listening` is a temporary alias until the real clip is re-exported.
  'robot-blue': {
    listening: 'robot/robot-blue-thinking.webp',
    thinking: 'robot/robot-blue-thinking.webp',
    analyzing: 'robot/robot-blue-thinking.webp',
    searching: 'robot/robot-blue-searching.webp',
    writing: 'robot/robot-blue-writing.webp',
    working: 'robot/robot-blue-writing.webp',
    complete: 'robot/robot-blue-complete.webp',
    error: 'robot/robot-blue-error.webp',
    paused: 'robot/robot-blue-complete.webp',
  },
  // Sam ships four clips (idle/listening/thinking/writing); the remaining
  // states alias the nearest one. `complete` reuses the idle pose, over which
  // the client draws a green "Valider" badge (see AVATAR_VALIDATE_OVERLAY).
  // `paused`/`error` are intentionally absent and fall back to the base.
  sam: {
    listening: 'sam/listening.webp',
    thinking: 'sam/thinking.webp',
    writing: 'sam/writing.webp',
    analyzing: 'sam/thinking.webp',
    searching: 'sam/thinking.webp',
    working: 'sam/writing.webp',
    complete: 'sam/idle.webp',
  },
};

/**
 * Avatars that show a green "Valider" badge on top when the mascot state is
 * `complete` (they have no dedicated completion clip).
 */
export const AVATAR_VALIDATE_OVERLAY: readonly AvatarId[] = [
  'sam',
  'leo',
  'aline',
];

/** Whether an avatar draws the completion "Valider" badge. */
export function hasValidateOverlay(id: string | null | undefined): boolean {
  return !!id && (AVATAR_VALIDATE_OVERLAY as readonly string[]).includes(id);
}

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
