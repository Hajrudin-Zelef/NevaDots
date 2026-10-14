import { expect, it } from 'vitest';
import {
  AVATAR_FILES,
  AVATAR_IDS,
  avatarSrc,
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
  expect(avatarSrc('leo')).toBe('/dots/leo/idle.png');
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

it('has no state clips for still avatars', () => {
  expect(avatarStateSrc('mint', 'listening')).toBeNull();
  expect(avatarStateSrc('leo', 'working')).toBeNull();
  expect(avatarStateSrc(null, 'listening')).toBeNull();
});

it('flags which avatars draw the completion "Valider" badge', () => {
  expect(hasValidateOverlay('sam')).toBe(true);
  expect(hasValidateOverlay('leo')).toBe(true);
  expect(hasValidateOverlay('aline')).toBe(true);
  expect(hasValidateOverlay('mint')).toBe(false);
  expect(hasValidateOverlay(null)).toBe(false);
});

it('lists an avatar state clips for preloading', () => {
  expect(avatarStateFiles('sam')).toContain('/dots/sam/listening.webp');
  expect(avatarStateFiles('mint')).toEqual([]);
  expect(avatarStateFiles(undefined)).toEqual([]);
});
