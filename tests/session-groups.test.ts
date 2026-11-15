import { afterEach, describe, expect, it, vi } from 'vitest';

{
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  });
}

import { dotAvatarStyle, dotHue } from '../src/client/dot-color';
import {
  READ_SEEN_KEY,
  hasUnread,
  isUnread,
  loadSeen,
  markSeen,
  saveSeen,
} from '../src/client/read-state';
import type { Conversation } from '../src/shared/types';

afterEach(() => {
  localStorage.clear();
});

function conversation(
  id: string,
  createdAt: number,
  updatedAt?: number | null,
): Conversation {
  return {
    id,
    dotId: 'dot-1',
    ownerId: 'owner',
    title: id,
    createdAt,
    isMaster: false,
    updatedAt,
  };
}

describe('dotHue / dotAvatarStyle', () => {
  it('is stable per Dot id and in range 0–359', () => {
    expect(dotHue('dot-a')).toBe(dotHue('dot-a'));
    expect(dotHue('dot-a')).toBeGreaterThanOrEqual(0);
    expect(dotHue('dot-a')).toBeLessThan(360);
  });
  it('returns a white-on-tinted avatar style', () => {
    const style = dotAvatarStyle('dot-a');
    expect(style.color).toBe('#ffffff');
    expect(style.backgroundColor).toMatch(/^hsl\(\d+ 45% 42%\)$/);
    expect(dotAvatarStyle('dot-a').backgroundColor).toBe(style.backgroundColor);
  });
});

describe('read-state', () => {
  it('a conversation is unread until opened', () => {
    const thread = conversation('t1', 1_000);
    expect(isUnread(thread, {})).toBe(true);
    const seen = markSeen({}, 't1', 2_000);
    expect(isUnread(thread, seen)).toBe(false);
    expect(seen).toEqual({ t1: 2_000 });
  });
  it('new activity after the last open makes it unread again', () => {
    const seen = markSeen({}, 't1', 2_000);
    const thread = conversation('t1', 1_000, 3_000);
    expect(isUnread(thread, seen)).toBe(true);
  });
  it('hasUnread is true when any conversation is unread', () => {
    const threads = [conversation('a', 1_000), conversation('b', 1_000)];
    expect(hasUnread(threads, {})).toBe(true);
    expect(hasUnread(threads, { a: 2_000, b: 2_000 })).toBe(false);
  });
  it('persists the seen map in localStorage, tolerating bad data', () => {
    saveSeen({ t1: 2_000 });
    expect(loadSeen()).toEqual({ t1: 2_000 });
    expect(JSON.parse(localStorage.getItem(READ_SEEN_KEY)!)).toEqual({
      t1: 2_000,
    });
    localStorage.setItem(READ_SEEN_KEY, 'not json');
    expect(loadSeen()).toEqual({});
    localStorage.setItem(READ_SEEN_KEY, JSON.stringify({ t1: 'soon' }));
    expect(loadSeen()).toEqual({});
  });
});
