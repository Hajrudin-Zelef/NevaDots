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

import {
  SIDEBAR_WIDTH_KEY,
  parseSidebarWidth,
  readSidebarWidth,
} from '../src/client/sidebar-width';

afterEach(() => {
  localStorage.clear();
});

describe('parseSidebarWidth', () => {
  it('returns 240 px when the key is absent (fresh profile)', () => {
    expect(parseSidebarWidth(null)).toBe(240);
  });
  it('returns 240 px for an empty or blank value', () => {
    expect(parseSidebarWidth('')).toBe(240);
    expect(parseSidebarWidth('   ')).toBe(240);
  });
  it('returns 240 px for a non-numeric value', () => {
    expect(parseSidebarWidth('abc')).toBe(240);
    expect(parseSidebarWidth('240px')).toBe(240);
    expect(parseSidebarWidth('NaN')).toBe(240);
    expect(parseSidebarWidth('Infinity')).toBe(240);
  });
  it('returns 240 px for zero or a negative value', () => {
    expect(parseSidebarWidth('0')).toBe(240);
    expect(parseSidebarWidth('-50')).toBe(240);
  });
  it('clamps a valid value to 136–640 px', () => {
    expect(parseSidebarWidth('100')).toBe(136);
    expect(parseSidebarWidth('136')).toBe(136);
    expect(parseSidebarWidth('240')).toBe(240);
    expect(parseSidebarWidth('300')).toBe(300);
    expect(parseSidebarWidth('640')).toBe(640);
    expect(parseSidebarWidth('900')).toBe(640);
  });
  it('accepts a numeric value with surrounding whitespace', () => {
    expect(parseSidebarWidth(' 300 ')).toBe(300);
  });
});

describe('readSidebarWidth', () => {
  it('returns 240 px on a fresh profile (no stored key)', () => {
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
    expect(readSidebarWidth()).toBe(240);
  });
  it('returns the stored width, clamped', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
    expect(readSidebarWidth()).toBe(300);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '900');
    expect(readSidebarWidth()).toBe(640);
  });
  it('returns 240 px for a stored garbage value', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, 'abc');
    expect(readSidebarWidth()).toBe(240);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '');
    expect(readSidebarWidth()).toBe(240);
  });
});
