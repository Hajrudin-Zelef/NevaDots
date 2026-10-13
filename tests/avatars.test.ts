import { expect, it } from 'vitest';
import {
  AVATAR_FILES,
  AVATAR_IDS,
  avatarSrc,
  avatarStateFiles,
  avatarStateSrc,
} from '../src/shared/avatars';

it('exposes the built-in avatars plus the animated robot', () => {
  expect(AVATAR_IDS).toContain('robot');
  expect(AVATAR_IDS).toHaveLength(7);
});

it('maps every id to a file in /dots', () => {
  for (const id of AVATAR_IDS) {
    expect(AVATAR_FILES[id]).toBeTruthy();
    expect(avatarSrc(id)).toBe(`/dots/${AVATAR_FILES[id]}`);
  }
});

it('serves the robot as an animated WebP', () => {
  expect(avatarSrc('robot')).toBe('/dots/robot.webp');
});

it('returns null for null and unknown ids', () => {
  expect(avatarSrc(null)).toBeNull();
  expect(avatarSrc(undefined)).toBeNull();
  expect(avatarSrc('nope')).toBeNull();
});

it('resolves per-state clips for the robot, falling back otherwise', () => {
  expect(avatarStateSrc('robot', 'listening')).toBe('/dots/robot-listening.webp');
  expect(avatarStateSrc('robot', 'working')).toBe('/dots/robot-working.webp');
  // no clip for this state / this avatar → caller falls back to the base file
  expect(avatarStateSrc('robot', 'idle')).toBeNull();
  expect(avatarStateSrc('robot', 'complete')).toBeNull();
  expect(avatarStateSrc('blue', 'listening')).toBeNull();
  expect(avatarStateSrc(null, 'listening')).toBeNull();
});

it('lists an avatar state clips for preloading', () => {
  expect(avatarStateFiles('robot')).toContain('/dots/robot-thinking.webp');
  expect(avatarStateFiles('blue')).toEqual([]);
  expect(avatarStateFiles(undefined)).toEqual([]);
});
