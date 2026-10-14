/**
 * Single source of truth for Dot avatars, shared by client and server.
 *
 * The avatar stored on a Dot is a bare id (see `Dot.avatar`). The extension
 * lives here, so an avatar may be a still PNG or an animated WebP. Server code
 * imports this file with a `.js` suffix (node16 build); client code may omit it.
 *
 * Assets are grouped by family under `public/dots/` (served at `/dots/<path>`):
 *   classic/  the remaining still PNG avatars (mint, orange, purple)
 *   sam/      NevaDots Dot "Sam" (animated, full set of state aliases)
 *   leo/      NevaDots Dot "Leo" (still base for now; clips to come)
 *   aline/    NevaDots Dot "Aline" (still base for now; clips to come)
 *
 * The former `blue`/`pink`/`green` PNGs and the `robot`/`robot-blue` animated
 * robots were retired (archived in the confidential OffLineFork area). Any Dot
 * still pointing at them falls back to an identity-derived kept avatar (see
 * `Mascot.tsx`).
 */
export const AVATAR_IDS = [
  'sam',
  'aline',
  'leo',
  'mint',
  'orange',
  'purple',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

/** id → file under `public/dots/` (served at `/dots/<file>`). */
export const AVATAR_FILES: Record<AvatarId, string> = {
  mint: 'classic/mint.png',
  orange: 'classic/orange.png',
  purple: 'classic/purple.png',
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
