import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const dataset: Record<string, string> = {};

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
});
vi.stubGlobal('document', { documentElement: { dataset } });

async function fresh() {
  vi.resetModules();
  return import('../src/client/motion-pref');
}

beforeEach(() => {
  store.clear();
  for (const key of Object.keys(dataset)) delete dataset[key];
});

describe('motion preference', () => {
  it("defaults to 'full' and applies it pre-paint", async () => {
    const mod = await fresh();
    expect(mod.motionPreference()).toBe('full');
    mod.applyMotionPreference();
    expect(dataset.motion).toBe('full');
  });

  it('persists reduced and applies it to <html>', async () => {
    const mod = await fresh();
    mod.setMotionPreference('reduced');
    expect(store.get('nevadots-motion')).toBe('reduced');
    expect(dataset.motion).toBe('reduced');
    expect(mod.motionPreference()).toBe('reduced');
  });

  it("removes the key for 'full' (default needs no storage)", async () => {
    const mod = await fresh();
    mod.setMotionPreference('off');
    expect(store.get('nevadots-motion')).toBe('off');
    mod.setMotionPreference('full');
    expect(store.has('nevadots-motion')).toBe(false);
    expect(dataset.motion).toBe('full');
  });

  it('ignores invalid stored values', async () => {
    store.set('nevadots-motion', 'turbo');
    const mod = await fresh();
    expect(mod.motionPreference()).toBe('full');
  });

  it('survives unavailable storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    const mod = await fresh();
    expect(mod.motionPreference()).toBe('full');
    mod.setMotionPreference('off');
    expect(dataset.motion).toBe('off');
    expect(mod.motionPreference()).toBe('off');
  });
});
