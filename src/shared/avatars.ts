/**
 * Single source of truth for Dot avatars, shared by client and server.
 *
 * The avatar stored on a Dot is a bare id (see `Dot.avatar`). The extension
 * lives here, so an avatar may be a still PNG or an animated WebP. Server code
 * imports this file with a `.js` suffix (node16 build); client code may omit it.
 *
 * Assets are grouped by family under `public/dots/` (served at `/dots/<path>`):
 *   classic/  the remaining still PNG avatars (mint, orange, purple)
 *   sam/      NevaDots Dot "Sam" (animated)
 *   leo/      NevaDots Dot "Leo" (animated; two variants for some states)
 *   aline/    NevaDots Dot "Aline" (still base for now; clips to come)
 *
 * Animated clips ship in three fps tiers (see `AvatarQuality`): the base
 * `<state>.webp` is "high", `<state>.15.webp` "standard" and `<state>.12.webp`
 * "low". Each animated avatar also has a tiny still `poster.webp` used as an
 * instant placeholder while the clip loads.
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
export const AVATAR_ASSET_VERSION = '10';

/** Concrete animation tiers, cheapest first. */
export type AvatarQuality = 'low' | 'standard' | 'high';

/** The user's stored preference: a concrete tier, or automatic selection. */
export type AvatarQualitySetting = 'auto' | AvatarQuality;

export const AVATAR_QUALITY_SETTINGS: readonly AvatarQualitySetting[] = [
  'auto',
  'low',
  'standard',
  'high',
];

/** Default preference (auto-adapts to the connection/device). */
export const DEFAULT_AVATAR_QUALITY_SETTING: AvatarQualitySetting = 'auto';

/** Tier used when nothing else is known (no Network/Device API, etc.). */
export const DEFAULT_AVATAR_QUALITY: AvatarQuality = 'standard';

/** fps of each tier (the file suffix used for non-high tiers). */
export const AVATAR_QUALITY_FPS: Record<AvatarQuality, number> = {
  low: 12,
  standard: 15,
  high: 30,
};

/** File name for a clip at a given tier (high keeps the bare name). */
function tierFile(file: string, quality: AvatarQuality): string {
  if (quality === 'high' || !file.endsWith('.webp')) return file;
  return file.replace(/\.webp$/, `.${AVATAR_QUALITY_FPS[quality]}.webp`);
}

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
  leo: 'leo/idle-6.webp',
  aline: 'aline/idle.png',
};

/** Directory of an avatar's assets under `public/dots/`. */
function avatarDir(id: AvatarId): string {
  return AVATAR_FILES[id].replace(/\/[^/]+$/, '');
}

/** Public URL for an avatar id at a tier, or `null` when the id is unknown. */
export function avatarSrc(
  id: string | null | undefined,
  quality: AvatarQuality = DEFAULT_AVATAR_QUALITY,
): string | null {
  if (!id || !(id in AVATAR_FILES)) return null;
  return dotUrl(tierFile(AVATAR_FILES[id as AvatarId], quality));
}

/**
 * Small still used as a thumbnail (pickers) and as an instant placeholder while
 * an animated clip loads. Falls back to the avatar itself for still avatars.
 */
export function avatarPoster(
  id: string | null | undefined,
  quality: AvatarQuality = DEFAULT_AVATAR_QUALITY,
): string | null {
  if (!id || !(id in AVATAR_FILES)) return null;
  const animated = !!AVATAR_STATE_FILES[id as AvatarId];
  if (!animated) return avatarSrc(id, quality);
  return dotUrl(`${avatarDir(id as AvatarId)}/poster.webp`);
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
  // Leo — génération MP4 (pastilles blanches, masque rond CSS) : les
  // anciens clips (idle-1..5, etc.) restent sur disque, débranchés.
  // `complete` reuse l'idle (badge "Valider" vert).
  leo: {
    idle: ['leo/idle-6.webp'],
    listening: ['leo/listening-4.webp', 'leo/listening-5.webp'],
    thinking: [
      'leo/thinking-4.webp',
      'leo/thinking-5.webp',
      'leo/thinking-6.webp',
    ],
    writing: ['leo/writing-3.webp'],
    analyzing: [
      'leo/thinking-4.webp',
      'leo/thinking-5.webp',
      'leo/thinking-6.webp',
    ],
    searching: [
      'leo/thinking-4.webp',
      'leo/thinking-5.webp',
      'leo/thinking-6.webp',
    ],
    working: ['leo/writing-3.webp'],
    complete: 'leo/idle-6.webp',
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

/** Every clip URL declared for an avatar state at a tier (one per variant). */
export function avatarStateCandidates(
  id: string | null | undefined,
  state: string,
  quality: AvatarQuality = DEFAULT_AVATAR_QUALITY,
): string[] {
  if (!id) return [];
  const file = AVATAR_STATE_FILES[id as AvatarId]?.[state];
  if (!file) return [];
  return (Array.isArray(file) ? file : [file]).map((f) =>
    dotUrl(tierFile(f, quality)),
  );
}

/** First declared clip URL for a state, or `null` to fall back to the base. */
export function avatarStateSrc(
  id: string | null | undefined,
  state: string,
  quality: AvatarQuality = DEFAULT_AVATAR_QUALITY,
): string | null {
  return avatarStateCandidates(id, state, quality)[0] ?? null;
}

/** Every state-clip URL declared for an avatar at a tier (for preloading). */
export function avatarStateFiles(
  id: string | null | undefined,
  quality: AvatarQuality = DEFAULT_AVATAR_QUALITY,
): string[] {
  if (!id) return [];
  const map = AVATAR_STATE_FILES[id as AvatarId];
  if (!map) return [];
  return Object.values(map)
    .flatMap((file) => (Array.isArray(file) ? file : [file]))
    .map((f) => dotUrl(tierFile(f, quality)));
}
