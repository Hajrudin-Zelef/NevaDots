import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVoice } from '../src/client/useVoice';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api, authHeaders: () => ({}) }));
let voice: ReturnType<typeof useVoice>;
let root: ReactTestRenderer;
let pc: FakePeer;
const track = { stop: vi.fn(), enabled: true };
class FakePeer {
  connectionState = 'new';
  onconnectionstatechange?: () => void;
  channel = { close: vi.fn(), readyState: 'open' };
  constructor() {
    // The test needs the peer created by the hook, like a browser constructor.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    pc = this;
  }
  createDataChannel() {
    return this.channel;
  }
  addTrack() {}
  async createOffer() {
    return { sdp: 'offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
  state(value: string) {
    this.connectionState = value;
    this.onconnectionstatechange?.();
  }
}
function Hook() {
  voice = useVoice('thread', () => {});
  return null;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  vi.stubGlobal(
    'Audio',
    class {
      autoplay = false;
      srcObject = null;
      pause() {}
    },
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
  api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === '/voice/calls'
        ? { id: 'call', sdp: 'answer' }
        : { endedAt: null },
    );
  await act(async () => {
    root = create(createElement(Hook));
  });
  await act(async () => {
    await voice.start();
    pc.state('connected');
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const ends = () => api.mock.calls.filter(([path]) => path.endsWith('/end'));
it('allows a transient disconnect to recover within five seconds', async () => {
  await act(async () => {
    pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(ends()).toHaveLength(0);
  await act(async () => {
    pc.state('connected');
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(0);
  expect(voice.status).toBe('active');
});
it('rejoint au lieu de finir après cinq secondes de coupure persistante', async () => {
  await act(async () => {
    pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(4999);
  });
  expect(ends()).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  // Rejoin (pas fin) : nouveau POST de call, pas de POST de fin.
  expect(ends()).toHaveLength(0);
  expect(voice.status).toBe('connecting');
  expect(voice.reconnecting).toBe(true);
});
it('ne prolonge pas la grâce mais ne relance qu’une seule reprise', async () => {
  await act(async () => {
    pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(2000);
  });
  // Une seule reprise après la grâce initiale, pas une par événement.
  expect(ends()).toHaveLength(0);
  expect(voice.reconnecting).toBe(true);
});
it('rejoint immédiatement sur échec, sans attendre la grâce', async () => {
  await act(async () => {
    pc.state('disconnected');
    pc.state('failed');
  });
  expect(ends()).toHaveLength(0);
  expect(voice.reconnecting).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(ends()).toHaveLength(0);
});
it('clears disconnect timers on manual end', async () => {
  await act(async () => {
    pc.state('disconnected');
    await voice.end();
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(1);
});
it('clears disconnect timers on unmount', async () => {
  await act(async () => {
    pc.state('disconnected');
    root.unmount();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(0);
});
