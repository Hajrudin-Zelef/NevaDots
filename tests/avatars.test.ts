import { expect, it } from 'vitest';
import {
  AVATAR_ASSET_VERSION,
  AVATAR_FILES,
  AVATAR_IDS,
  DEFAULT_AVATAR,
  PROTECTED_AVATARS,
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

it('defaults to the main Dot "leo"', () => {
  expect(DEFAULT_AVATAR).toBe('leo');
  expect(AVATAR_IDS).toContain(DEFAULT_AVATAR);
});

it('maps every id to a cache-busted file in /dots', () => {
  for (const id of AVATAR_IDS) {
    expect(AVATAR_FILES[id]).toBeTruthy();
    expect(avatarSrc(id)).toBe(u(AVATAR_FILES[id]));
  }
});

it('groups assets under a per-family folder', () => {
  expect(avatarSrc('mint')).toBe(u('classic/mint.png'));
  expect(avatarSrc('orange')).toBe(u('classic/orange.png'));
  expect(avatarSrc('purple')).toBe(u('classic/purple.png'));
  expect(avatarSrc('sam')).toBe(u('sam/idle.webp'));
  expect(avatarSrc('leo')).toBe(u('leo/idle.webp'));
  expect(avatarSrc('aline')).toBe(u('aline/idle.png'));
});

it('returns null for null, unknown and retired ids', () => {
  expect(avatarSrc(null)).toBeNull();
  expect(avatarSrc(undefined)).toBeNull();
  expect(avatarSrc('nope')).toBeNull();
  expect(avatarSrc('blue')).toBeNull();
  expect(avatarSrc('robot')).toBeNull();
});

it('aliases the NevaDots Dot "sam" states to its four shipped clips', () => {
  // shipped clips
  expect(avatarStateSrc('sam', 'listening')).toBe(u('sam/listening.webp'));
  expect(avatarStateSrc('sam', 'thinking')).toBe(u('sam/thinking.webp'));
  expect(avatarStateSrc('sam', 'writing')).toBe(u('sam/writing.webp'));
  // aliases reuse the nearest clip
  expect(avatarStateSrc('sam', 'analyzing')).toBe(u('sam/thinking.webp'));
  expect(avatarStateSrc('sam', 'searching')).toBe(u('sam/thinking.webp'));
  expect(avatarStateSrc('sam', 'working')).toBe(u('sam/writing.webp'));
  // complete reuses the idle pose (the client overlays a "Valider" badge)
  expect(avatarStateSrc('sam', 'complete')).toBe(u('sam/idle.webp'));
  // deliberately absent → base fallback
  expect(avatarStateSrc('sam', 'paused')).toBeNull();
  expect(avatarStateSrc('sam', 'error')).toBeNull();
  expect(avatarStateSrc('sam', 'idle')).toBeNull();
});

it('gives "leo" two interchangeable variants per animated state', () => {
  expect(avatarStateCandidates('leo', 'listening')).toEqual([
    u('leo/listening-1.webp'),
    u('leo/listening-2.webp'),
  ]);
  expect(avatarStateCandidates('leo', 'thinking')).toEqual([
    u('leo/thinking-1.webp'),
    u('leo/thinking-2.webp'),
  ]);
  expect(avatarStateCandidates('leo', 'writing')).toEqual([
    u('leo/writing-1.webp'),
    u('leo/writing-2.webp'),
  ]);
  // aliases share the thinking/writing variants
  expect(avatarStateCandidates('leo', 'analyzing')).toEqual(
    avatarStateCandidates('leo', 'thinking'),
  );
  expect(avatarStateCandidates('leo', 'searching')).toEqual(
    avatarStateCandidates('leo', 'thinking'),
  );
  expect(avatarStateCandidates('leo', 'working')).toEqual(
    avatarStateCandidates('leo', 'writing'),
  );
  // complete reuses idle; absent states fall back
  expect(avatarStateCandidates('leo', 'complete')).toEqual([
    u('leo/idle.webp'),
  ]);
  expect(avatarStateCandidates('leo', 'paused')).toEqual([]);
  expect(avatarStateCandidates('leo', 'idle')).toEqual([]);
  // avatarStateSrc is the deterministic first candidate
  expect(avatarStateSrc('leo', 'listening')).toBe(u('leo/listening-1.webp'));
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
  expect(avatarStateFiles('sam')).toContain(u('sam/listening.webp'));
  // leo exposes both variants of every animated state
  expect(avatarStateFiles('leo')).toContain(u('leo/listening-1.webp'));
  expect(avatarStateFiles('leo')).toContain(u('leo/listening-2.webp'));
  expect(avatarStateFiles('leo')).toContain(u('leo/thinking-2.webp'));
  expect(avatarStateFiles('leo')).toContain(u('leo/writing-1.webp'));
  expect(avatarStateFiles('mint')).toEqual([]);
  expect(avatarStateFiles(undefined)).toEqual([]);
});
