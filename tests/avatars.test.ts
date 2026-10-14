import { expect, it } from 'vitest';
import {
  AVATAR_FILES,
  AVATAR_IDS,
  avatarSrc,
  avatarStateFiles,
  avatarStateSrc,
  hasValidateOverlay,
} from '../src/shared/avatars';

it('exposes the built-in avatars, the animated robots and the NevaDots Dots', () => {
  expect(AVATAR_IDS).toContain('robot');
  expect(AVATAR_IDS).toContain('robot-blue');
  expect(AVATAR_IDS).toContain('sam');
  expect(AVATAR_IDS).toContain('leo');
  expect(AVATAR_IDS).toContain('aline');
  expect(AVATAR_IDS).toHaveLength(11);
});

it('maps every id to a file in /dots', () => {
  for (const id of AVATAR_IDS) {
    expect(AVATAR_FILES[id]).toBeTruthy();
    expect(avatarSrc(id)).toBe(`/dots/${AVATAR_FILES[id]}`);
  }
});

it('groups assets under a per-family folder', () => {
  expect(avatarSrc('blue')).toBe('/dots/classic/blue.png');
  expect(avatarSrc('robot')).toBe('/dots/robot/robot.webp');
  expect(avatarSrc('sam')).toBe('/dots/sam/idle.webp');
  expect(avatarSrc('leo')).toBe('/dots/leo/idle.png');
  expect(avatarSrc('aline')).toBe('/dots/aline/idle.png');
});

it('returns null for null and unknown ids', () => {
  expect(avatarSrc(null)).toBeNull();
  expect(avatarSrc(undefined)).toBeNull();
  expect(avatarSrc('nope')).toBeNull();
});

it('resolves per-state clips for the robot, falling back otherwise', () => {
  expect(avatarStateSrc('robot', 'listening')).toBe(
    '/dots/robot/robot-listening.webp',
  );
  expect(avatarStateSrc('robot', 'working')).toBe(
    '/dots/robot/robot-working.webp',
  );
  expect(avatarStateSrc('robot', 'complete')).toBe(
    '/dots/robot/robot-complete.webp',
  );
  // no clip for this state / this avatar → caller falls back to the base file
  expect(avatarStateSrc('robot', 'idle')).toBeNull();
  expect(avatarStateSrc('robot', 'needs-input')).toBeNull();
  expect(avatarStateSrc('blue', 'listening')).toBeNull();
  expect(avatarStateSrc(null, 'listening')).toBeNull();
});

it('aliases the blue robot missing states to the nearest blue clip', () => {
  // shipped clips
  expect(avatarStateSrc('robot-blue', 'thinking')).toBe(
    '/dots/robot/robot-blue-thinking.webp',
  );
  expect(avatarStateSrc('robot-blue', 'writing')).toBe(
    '/dots/robot/robot-blue-writing.webp',
  );
  // aliases stay on the blue robot (no green flick)
  expect(avatarStateSrc('robot-blue', 'analyzing')).toBe(
    '/dots/robot/robot-blue-thinking.webp',
  );
  expect(avatarStateSrc('robot-blue', 'working')).toBe(
    '/dots/robot/robot-blue-writing.webp',
  );
  expect(avatarStateSrc('robot-blue', 'paused')).toBe(
    '/dots/robot/robot-blue-complete.webp',
  );
  // idle uses the base file
  expect(avatarStateSrc('robot-blue', 'idle')).toBeNull();
  expect(avatarSrc('robot-blue')).toBe('/dots/robot/robot-blue-complete.webp');
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

it('flags which avatars draw the completion "Valider" badge', () => {
  expect(hasValidateOverlay('sam')).toBe(true);
  expect(hasValidateOverlay('leo')).toBe(true);
  expect(hasValidateOverlay('aline')).toBe(true);
  expect(hasValidateOverlay('robot')).toBe(false);
  expect(hasValidateOverlay('blue')).toBe(false);
  expect(hasValidateOverlay(null)).toBe(false);
});

it('lists an avatar state clips for preloading', () => {
  expect(avatarStateFiles('robot')).toContain(
    '/dots/robot/robot-thinking.webp',
  );
  expect(avatarStateFiles('sam')).toContain('/dots/sam/listening.webp');
  expect(avatarStateFiles('blue')).toEqual([]);
  expect(avatarStateFiles(undefined)).toEqual([]);
});
