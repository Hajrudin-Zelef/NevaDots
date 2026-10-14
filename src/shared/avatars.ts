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
 *   leo/      NevaDots Dot "Leo" (animated; two variants for some states)
 *   aline/    NevaDots Dot "Aline" (still base for now; clips to come)
 *
 * The former `blue`/`pink`/`green` PNGs and the `robot`/`robot-blue` animated
 * robots were retired (archived in the confidential OffLineFork area). Any Dot
 * still pointing at them falls back to the default avatar (see `Mascot.tsx`).
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

/** The avatar shown when a Dot has none (or an unknown/retired id). */
export const DEFAULT_AVATAR: AvatarId = 'leo';

/**
 * Bump this whenever a file under `public/dots/` changes. Avatar URLs carry it
 * as a query so the browser (which caches `/dots/` for a day) fetches the new
 * art instead of a stale copy.
 */
export const AVATAR_ASSET_VERSION = '2';

/** URL of a file under `public/dots/`, cache-busted. */
function dotUrl(file: string): string {
  return `/dots/${file}?v=${AVATAR_ASSET_VERSION}`;
}

/** id → file under `public/dots/` (served at `/dots/<file>`). */
export const AVATAR_FILES: Record<AvatarId, string> = {
  mint: 'classic/mint.png',
  orange: 'classic/orange.png',
  purple: 'classic/purple.png',
  sam: 'sam/idle.webp',
  leo: 'leo/idle.webp',
  aline: 'aline/idle.png',
};

/** Public URL for an avatar id, or `null` when the id is unknown. */
export function avatarSrc(id: string | null | undefined): string | null {
  if (!id || !(id in AVATAR_FILES)) return null;
  return dotUrl(AVATAR_FILES[id as AvatarId]);
}

/**
 * Optional per-state animation clips, keyed by the app's mascot state. A value
 * is either one file or several interchangeable variants; the client picks one
 * at random on each state entry (see `Mascot.tsx`). Missing states fall back to
 * the base file (see `avatarStateCandidates`). Files live under `public/dots/`.
 */
export const AVATAR_STATE_FILES: Partial<
  Record<AvatarId, Record<string, string | string[]>>
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
  // Leo ships two interchangeable variants for listening/thinking/writing; the
  // client picks one at random per state entry so successive requests differ.
  leo: {
    listening: ['leo/listening-1.webp', 'leo/listening-2.webp'],
    thinking: ['leo/thinking-1.webp', 'leo/thinking-2.webp'],
    writing: ['leo/writing-1.webp', 'leo/writing-2.webp'],
    analyzing: ['leo/thinking-1.webp', 'leo/thinking-2.webp'],
    searching: ['leo/thinking-1.webp', 'leo/thinking-2.webp'],
    working: ['leo/writing-1.webp', 'leo/writing-2.webp'],
    complete: 'leo/idle.webp',
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

/**
 * NevaDots avatars are the owner's private art: the client blocks the browser
 * context menu ("Save image as…") and drag on them. The static classics
 * (mint/orange/purple) stay unhindered.
 */
export const PROTECTED_AVATARS: readonly AvatarId[] = ['leo', 'sam', 'aline'];

/** Whether an avatar is protected against right-click / drag. */
export function isProtectedAvatar(id: string | null | undefined): boolean {
  return !!id && (PROTECTED_AVATARS as readonly string[]).includes(id);
}

/** Every clip URL declared for an avatar state (one per variant). */
export function avatarStateCandidates(
  id: string | null | undefined,
  state: string,
): string[] {
  if (!id) return [];
  const file = AVATAR_STATE_FILES[id as AvatarId]?.[state];
  if (!file) return [];
  return (Array.isArray(file) ? file : [file]).map(dotUrl);
}

/** First declared clip URL for a state, or `null` to fall back to the base. */
export function avatarStateSrc(
  id: string | null | undefined,
  state: string,
): string | null {
  return avatarStateCandidates(id, state)[0] ?? null;
}

/** Every state-clip URL declared for an avatar (for idle-time preloading). */
export function avatarStateFiles(id: string | null | undefined): string[] {
  if (!id) return [];
  const map = AVATAR_STATE_FILES[id as AvatarId];
  if (!map) return [];
  return Object.values(map)
    .flatMap((file) => (Array.isArray(file) ? file : [file]))
    .map(dotUrl);
}
