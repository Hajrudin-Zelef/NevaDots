import { expect, it } from 'vitest';
import {
  AVATAR_ASSET_VERSION,
  AVATAR_FILES,
  AVATAR_IDS,
  AVATAR_QUALITY_FPS,
  AVATAR_QUALITY_SETTINGS,
  DEFAULT_AVATAR,
  DEFAULT_AVATAR_QUALITY,
  DEFAULT_AVATAR_QUALITY_SETTING,
  PROTECTED_AVATARS,
  avatarPoster,
  avatarSrc,
  avatarStateCandidates,
  avatarStateFiles,
  avatarStateSrc,
  hasValidateOverlay,
  isProtectedAvatar,
} from '../src/shared/avatars';

/** Expected cache-busted URL for a file under public/dots. */
const u = (file: string) => `/dots/${file}?v=${AVATAR_ASSET_VERSION}`;

it('exposes only the three NevaDots Dots and the three kept classics', () => {
  expect(AVATAR_IDS).toEqual([
    'sam',
    'aline',
    'leo',
    'mint',
    'orange',
    'purple',
  ]);
  // retired avatars are gone
  expect(AVATAR_IDS).not.toContain('blue');
  expect(AVATAR_IDS).not.toContain('pink');
  expect(AVATAR_IDS).not.toContain('green');
  expect(AVATAR_IDS).not.toContain('robot');
  expect(AVATAR_IDS).not.toContain('robot-blue');
});

it('defaults to the main Dot "leo" and to the standard animation tier', () => {
  expect(DEFAULT_AVATAR).toBe('leo');
  expect(AVATAR_IDS).toContain(DEFAULT_AVATAR);
  expect(DEFAULT_AVATAR_QUALITY).toBe('standard');
  expect(DEFAULT_AVATAR_QUALITY_SETTING).toBe('auto');
  expect(AVATAR_QUALITY_SETTINGS).toEqual(['auto', 'low', 'standard', 'high']);
  expect(AVATAR_QUALITY_FPS).toEqual({ low: 12, standard: 15, high: 30 });
});

it('maps every id to a cache-busted file in /dots (default tier)', () => {
  for (const id of AVATAR_IDS) {
    expect(AVATAR_FILES[id]).toBeTruthy();
    // the default tier is standard; stills are unchanged
    const expected = AVATAR_FILES[id].endsWith('.webp')
      ? AVATAR_FILES[id].replace(/\.webp$/, '.15.webp')
      : AVATAR_FILES[id];
    expect(avatarSrc(id)).toBe(u(expected));
  }
});

it('groups assets under a per-family folder and tiers the animated ones', () => {
  expect(avatarSrc('mint')).toBe(u('classic/mint.png'));
  expect(avatarSrc('sam')).toBe(u('sam/idle.15.webp'));
  expect(avatarSrc('leo')).toBe(u('leo/idle-6.15.webp'));
  expect(avatarSrc('aline')).toBe(u('aline/idle.png'));
  // explicit tiers (high keeps the bare name; stills ignore the tier)
  expect(avatarSrc('leo', 'high')).toBe(u('leo/idle-6.webp'));
  expect(avatarSrc('leo', 'low')).toBe(u('leo/idle-6.12.webp'));
  expect(avatarSrc('leo', 'standard')).toBe(u('leo/idle-6.15.webp'));
  expect(avatarSrc('mint', 'low')).toBe(u('classic/mint.png'));
  expect(avatarSrc('mint', 'high')).toBe(u('classic/mint.png'));
});

it('returns null for null, unknown and retired ids', () => {
  expect(avatarSrc(null)).toBeNull();
  expect(avatarSrc(undefined)).toBeNull();
  expect(avatarSrc('nope')).toBeNull();
  expect(avatarSrc('blue')).toBeNull();
  expect(avatarSrc('robot')).toBeNull();
});

it('offers a tiny still poster for animated avatars, else the avatar itself', () => {
  expect(avatarPoster('leo')).toBe(u('leo/poster.webp'));
  expect(avatarPoster('sam')).toBe(u('sam/poster.webp'));
  // still avatars have no poster → the still file
  expect(avatarPoster('mint')).toBe(u('classic/mint.png'));
  expect(avatarPoster('aline')).toBe(u('aline/idle.png'));
  expect(avatarPoster(null)).toBeNull();
  expect(avatarPoster('nope')).toBeNull();
});

it('aliases the NevaDots Dot "sam" states to its four shipped clips', () => {
  // shipped clips (standard tier)
  expect(avatarStateSrc('sam', 'listening')).toBe(u('sam/listening.15.webp'));
  expect(avatarStateSrc('sam', 'thinking')).toBe(u('sam/thinking.15.webp'));
  expect(avatarStateSrc('sam', 'writing')).toBe(u('sam/writing.15.webp'));
  // aliases reuse the nearest clip
  expect(avatarStateSrc('sam', 'analyzing')).toBe(u('sam/thinking.15.webp'));
  expect(avatarStateSrc('sam', 'searching')).toBe(u('sam/thinking.15.webp'));
  expect(avatarStateSrc('sam', 'working')).toBe(u('sam/writing.15.webp'));
  // complete reuses the idle pose (the client overlays a "Valider" badge)
  expect(avatarStateSrc('sam', 'complete')).toBe(u('sam/idle.15.webp'));
  // high tier keeps the bare names
  expect(avatarStateSrc('sam', 'listening', 'high')).toBe(
    u('sam/listening.webp'),
  );
  // deliberately absent → base fallback
  expect(avatarStateSrc('sam', 'paused')).toBeNull();
  expect(avatarStateSrc('sam', 'error')).toBeNull();
  expect(avatarStateSrc('sam', 'idle')).toBeNull();
});

it('gives "leo" several interchangeable variants per animated state', () => {
  // MP4 generation (white discs): idle ×1, listening ×2, thinking ×3,
  // writing ×1 — old clips stay on disk, disconnected from the manifest.
  expect(avatarStateCandidates('leo', 'idle')).toEqual([
    u('leo/idle-6.15.webp'),
  ]);
  expect(avatarStateCandidates('leo', 'listening')).toEqual([
    u('leo/listening-4.15.webp'),
    u('leo/listening-5.15.webp'),
  ]);
  expect(avatarStateCandidates('leo', 'listening', 'low')).toEqual([
    u('leo/listening-4.12.webp'),
    u('leo/listening-5.12.webp'),
  ]);
  // aliases share the thinking/writing variants
  expect(avatarStateCandidates('leo', 'analyzing')).toEqual(
    avatarStateCandidates('leo', 'thinking'),
  );
  expect(avatarStateCandidates('leo', 'working')).toEqual(
    avatarStateCandidates('leo', 'writing'),
  );
  // complete reuses the first idle pose; absent states fall back
  expect(avatarStateCandidates('leo', 'complete')).toEqual([
    u('leo/idle-6.15.webp'),
  ]);
  expect(avatarStateCandidates('leo', 'paused')).toEqual([]);
  // avatarStateSrc is the deterministic first candidate
  expect(avatarStateSrc('leo', 'listening')).toBe(u('leo/listening-4.15.webp'));
});

it('has no state clips for still avatars', () => {
  expect(avatarStateSrc('mint', 'listening')).toBeNull();
  expect(avatarStateSrc('aline', 'working')).toBeNull();
  expect(avatarStateCandidates('mint', 'listening')).toEqual([]);
  expect(avatarStateSrc(null, 'listening')).toBeNull();
});

it('flags which avatars draw the completion "Valider" badge', () => {
  expect(hasValidateOverlay('sam')).toBe(true);
  expect(hasValidateOverlay('leo')).toBe(true);
  expect(hasValidateOverlay('aline')).toBe(true);
  expect(hasValidateOverlay('mint')).toBe(false);
  expect(hasValidateOverlay(null)).toBe(false);
});

it('protects only the NevaDots avatars against right-click / drag', () => {
  expect(PROTECTED_AVATARS).toEqual(['leo', 'sam', 'aline']);
  expect(isProtectedAvatar('leo')).toBe(true);
  expect(isProtectedAvatar('sam')).toBe(true);
  expect(isProtectedAvatar('aline')).toBe(true);
  // static classics stay unhindered
  expect(isProtectedAvatar('mint')).toBe(false);
  expect(isProtectedAvatar('orange')).toBe(false);
  expect(isProtectedAvatar('purple')).toBe(false);
  expect(isProtectedAvatar(null)).toBe(false);
  expect(isProtectedAvatar(undefined)).toBe(false);
});

it('lists every state clip of an avatar for preloading', () => {
  expect(avatarStateFiles('sam')).toContain(u('sam/listening.15.webp'));
  // leo exposes every variant of every animated state
  expect(avatarStateFiles('leo')).toContain(u('leo/listening-4.15.webp'));
  expect(avatarStateFiles('leo')).toContain(u('leo/listening-5.15.webp'));
  expect(avatarStateFiles('leo')).toContain(u('leo/idle-6.15.webp'));
  expect(avatarStateFiles('leo', 'high')).toContain(u('leo/thinking-4.webp'));
  expect(avatarStateFiles('mint')).toEqual([]);
  expect(avatarStateFiles(undefined)).toEqual([]);
});
