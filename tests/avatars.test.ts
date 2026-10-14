import { expect, it } from 'vitest';
import {
  AVATAR_FILES,
  AVATAR_IDS,
  DEFAULT_AVATAR,
  avatarSrc,
  avatarStateCandidates,
  avatarStateFiles,
  avatarStateSrc,
  hasValidateOverlay,
} from '../src/shared/avatars';

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

it('maps every id to a file in /dots', () => {
  for (const id of AVATAR_IDS) {
    expect(AVATAR_FILES[id]).toBeTruthy();
    expect(avatarSrc(id)).toBe(`/dots/${AVATAR_FILES[id]}`);
  }
});

it('groups assets under a per-family folder', () => {
  expect(avatarSrc('mint')).toBe('/dots/classic/mint.png');
  expect(avatarSrc('orange')).toBe('/dots/classic/orange.png');
  expect(avatarSrc('purple')).toBe('/dots/classic/purple.png');
  expect(avatarSrc('sam')).toBe('/dots/sam/idle.webp');
  expect(avatarSrc('leo')).toBe('/dots/leo/idle.webp');
  expect(avatarSrc('aline')).toBe('/dots/aline/idle.png');
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
  expect(avatarStateSrc('sam', 'listening')).toBe('/dots/sam/listening.webp');
  expect(avatarStateSrc('sam', 'thinking')).toBe('/dots/sam/thinking.webp');
  expect(avatarStateSrc('sam', 'writing')).toBe('/dots/sam/writing.webp');
  // aliases reuse the nearest clip
  expect(avatarStateSrc('sam', 'analyzing')).toBe('/dots/sam/thinking.webp');
  expect(avatarStateSrc('sam', 'searching')).toBe('/dots/sam/thinking.webp');
  expect(avatarStateSrc('sam', 'working')).toBe('/dots/sam/writing.webp');
  // complete reuses the idle pose (the client overlays a "Valider" badge)
  expect(avatarStateSrc('sam', 'complete')).toBe('/dots/sam/idle.webp');
  // deliberately absent → base fallback
  expect(avatarStateSrc('sam', 'paused')).toBeNull();
  expect(avatarStateSrc('sam', 'error')).toBeNull();
  expect(avatarStateSrc('sam', 'idle')).toBeNull();
});

it('gives "leo" two interchangeable variants per animated state', () => {
  expect(avatarStateCandidates('leo', 'listening')).toEqual([
    '/dots/leo/listening-1.webp',
    '/dots/leo/listening-2.webp',
  ]);
  expect(avatarStateCandidates('leo', 'thinking')).toEqual([
    '/dots/leo/thinking-1.webp',
    '/dots/leo/thinking-2.webp',
  ]);
  expect(avatarStateCandidates('leo', 'writing')).toEqual([
    '/dots/leo/writing-1.webp',
    '/dots/leo/writing-2.webp',
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
    '/dots/leo/idle.webp',
  ]);
  expect(avatarStateCandidates('leo', 'paused')).toEqual([]);
  expect(avatarStateCandidates('leo', 'idle')).toEqual([]);
  // avatarStateSrc is the deterministic first candidate
  expect(avatarStateSrc('leo', 'listening')).toBe('/dots/leo/listening-1.webp');
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

it('lists every state clip of an avatar for preloading', () => {
  expect(avatarStateFiles('sam')).toContain('/dots/sam/listening.webp');
  // leo exposes both variants of every animated state
  expect(avatarStateFiles('leo')).toContain('/dots/leo/listening-1.webp');
  expect(avatarStateFiles('leo')).toContain('/dots/leo/listening-2.webp');
  expect(avatarStateFiles('leo')).toContain('/dots/leo/thinking-2.webp');
  expect(avatarStateFiles('leo')).toContain('/dots/leo/writing-1.webp');
  expect(avatarStateFiles('mint')).toEqual([]);
  expect(avatarStateFiles(undefined)).toEqual([]);
});
