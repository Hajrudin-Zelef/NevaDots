import { describe, expect, it } from 'vitest';
import {
  MASCOT_HOLD_MS,
  drainMascotHold,
  enqueueMascotState,
  initialMascotHold,
} from '../src/client/useHeldMascotState';

const T = MASCOT_HOLD_MS;

describe('mascot hold', () => {
  it('keeps a held state on screen for the minimum time', () => {
    const state = initialMascotHold('thinking', 0);
    const enqueued = enqueueMascotState(state, 'writing', 200);
    // Too early to switch: still thinking, writing queued.
    const blocked = drainMascotHold(enqueued, 200);
    expect(blocked.shown).toBe('thinking');
    expect(blocked.queue).toEqual(['writing']);
    // After the floor elapses, writing takes over.
    const released = drainMascotHold(blocked, T);
    expect(released.shown).toBe('writing');
    expect(released.queue).toEqual([]);
  });

  it('shows reflection then writing for a fast run', () => {
    // thinking → (reasoning) analyzing → (generation) writing, all fast.
    let state = initialMascotHold('thinking', 0);
    state = drainMascotHold(enqueueMascotState(state, 'analyzing', 100), 100);
    expect(state.shown).toBe('thinking'); // reflection floor not elapsed
    state = drainMascotHold(state, T); // analyzing released at the floor
    expect(state.shown).toBe('analyzing');
    state = drainMascotHold(enqueueMascotState(state, 'writing', 900), 900);
    expect(state.shown).toBe('analyzing'); // generation arrives, but held
    state = drainMascotHold(state, 900 + T); // writing released
    expect(state.shown).toBe('writing');
  });

  it('does not let the completion flash skip writing', () => {
    let state = initialMascotHold('thinking', 0);
    state = enqueueMascotState(state, 'writing', 100);
    state = drainMascotHold(state, T); // writing released
    expect(state.shown).toBe('writing');
    state = enqueueMascotState(state, 'complete', T + 200);
    // Complete queues behind writing; it must not preempt it.
    state = drainMascotHold(state, T + 200);
    expect(state.shown).toBe('writing');
    state = drainMascotHold(state, T + 200 + T);
    expect(state.shown).toBe('complete');
  });

  it('lets voice take over instantly and clears the queue', () => {
    let state = initialMascotHold('thinking', 0);
    state = drainMascotHold(enqueueMascotState(state, 'writing', 100), 100);
    expect(state.queue).toEqual(['writing']);
    state = enqueueMascotState(state, 'listening', 120);
    expect(state.shown).toBe('listening');
    expect(state.queue).toEqual([]);
  });

  it('ignores duplicate raw states', () => {
    const state = initialMascotHold('idle', 0);
    const same = enqueueMascotState(state, 'idle', 50);
    expect(same).toBe(state);
    let queued = enqueueMascotState(state, 'writing', 60);
    queued = enqueueMascotState(queued, 'writing', 70);
    expect(queued.queue).toEqual(['writing']);
  });
});
