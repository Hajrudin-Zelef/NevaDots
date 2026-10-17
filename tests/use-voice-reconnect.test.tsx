import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.useFakeTimers();

const api = vi.hoisted(() => vi.fn());

vi.mock('../src/client/api', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api,
  authHeaders: () => ({}),
  hasToken: () => false,
  setToken: () => {},
}));

// ---- Faux navigateur ----
type Pc = {
  connectionState: string;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null;
  createDataChannel: () => FakeChannel;
  createOffer: () => Promise<{ sdp: string }>;
  setLocalDescription: () => Promise<void>;
  setRemoteDescription: () => Promise<void>;
  addTrack: () => void;
  close: () => void;
  restartIce?: () => void;
};
type FakeChannel = {
  readyState: string;
  send: (...args: unknown[]) => void;
  close: () => void;
  onmessage: ((event: { data: string }) => void) | null;
};
const pcs: Pc[] = [];
const channels: FakeChannel[] = [];

function fakeTrack() {
  return { stop: vi.fn(), enabled: true };
}
function fakeStream() {
  const tracks = [fakeTrack()];
  return { getTracks: () => tracks, getAudioTracks: () => tracks };
}

vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
vi.stubGlobal(
  'RTCPeerConnection',
  class {
    connectionState = 'new';
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    constructor() {
      pcs.push(this as unknown as Pc);
    }
    createDataChannel() {
      const channel: FakeChannel = {
        readyState: 'open',
        send: vi.fn(),
        close: vi.fn(),
        onmessage: null,
      };
      channels.push(channel);
      return channel;
    }
    async createOffer() {
      return { sdp: 'offer' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    addTrack() {}
    close() {}
  },
);
vi.stubGlobal(
  'Audio',
  class {
    autoplay = false;
    async play() {}
    pause() {}
    set srcObject(_value: unknown) {}
  },
);
vi.stubGlobal('MediaStream', class {});

import { useVoice } from '../src/client/useVoice';

let latest: ReturnType<typeof useVoice> | null = null;
function Probe({
  threadId,
  onSaved,
}: {
  threadId: string;
  onSaved: () => void;
}) {
  latest = useVoice(threadId, onSaved);
  return null;
}

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.clearAllMocks();
  pcs.length = 0;
  channels.length = 0;
});

beforeEach(() => {
  latest = null;
  (
    navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>
  ).mockResolvedValue(fakeStream());
  api.mockImplementation(async (path: string, method?: string) => {
    if (path === '/voice/calls' && method === 'POST')
      return { id: 'call-1', sdp: 'answer' };
    if (path === '/voice/calls/call-1') return { endedAt: null };
    return {};
  });
});

async function mount() {
  const onSaved = vi.fn();
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Probe, { threadId: 't1', onSaved }));
    roots.push(root!);
  });
  await act(async () => {});
  return { root: roots[roots.length - 1], onSaved };
}

function setPcState(pc: Pc, state: string) {
  pc.connectionState = state;
  pc.onconnectionstatechange?.();
}

it('reconnecte avec backoff après une coupure, borné à 5 tentatives', async () => {
  const { onSaved } = await mount();
  await act(async () => {
    await latest!.start();
  });
  await act(async () => {});
  expect(pcs).toHaveLength(1);
  setPcState(pcs[0], 'connected');
  await act(async () => {});
  expect(latest!.status).toBe('active');
  expect(latest!.reconnecting).toBe(false);

  // Coupure : grâce de 5 s, puis tentative 1 (délai 1 s).
  setPcState(pcs[0], 'disconnected');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(latest!.reconnecting).toBe(true);
  expect(latest!.reconnectAttempt).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  // Nouvelle session ouverte (rejoin), transcript préservé côté client.
  expect(pcs).toHaveLength(2);
  setPcState(pcs[1], 'connected');
  await act(async () => {});
  expect(latest!.status).toBe('active');
  expect(latest!.reconnecting).toBe(false);

  // 4 coupures de plus puis épuisement : l'appel se termine avec reçu.
  for (let i = 0; i < 4; i++) {
    setPcState(pcs[pcs.length - 1], 'disconnected');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const backoff = [2000, 4000, 8000, 16000][i];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoff);
    });
  }
  expect(pcs).toHaveLength(6); // 1 initial + 5 rejoins
  // 6e coupure : plafond atteint → fin normale, pas de 7e session.
  setPcState(pcs[pcs.length - 1], 'failed');
  await act(async () => {});
  await act(async () => {});
  expect(pcs).toHaveLength(6);
  expect(latest!.status).toBe('idle');
  expect(onSaved).toHaveBeenCalled();
});

it('renvoie le reçu manuellement après un échec réseau à la fin', async () => {
  const { onSaved } = await mount();
  await act(async () => {
    await latest!.start();
  });
  await act(async () => {});
  setPcState(pcs[0], 'connected');
  await act(async () => {});
  // Le POST de fin échoue une fois : reçu conservé, erreur visible.
  api.mockImplementationOnce(async () => {
    throw new Error('réseau coupé');
  });
  await act(async () => {
    await latest!.end();
  });
  expect(latest!.unsentReceipt).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
  // Le renvoi réussit : reçu posté, état nettoyé.
  api.mockImplementation(async (path: string, method?: string) => {
    if (path === '/voice/calls' && method === 'POST')
      return { id: 'call-1', sdp: 'answer' };
    if (path === '/voice/calls/call-1') return { endedAt: null };
    return {};
  });
  await act(async () => {
    await latest!.retryReceipt();
  });
  expect(latest!.unsentReceipt).toBe(false);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('reconnectDelayMs suit le backoff 1s → 16s', async () => {
  const { reconnectDelayMs } = await import('../src/client/useVoice.js');
  expect([1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([
    1000, 2000, 4000, 8000, 16000, 16000,
  ]);
});

it('ne duplique pas le transcript après plusieurs rejoins', async () => {
  await mount();
  await act(async () => {
    await latest!.start();
  });
  await act(async () => {});
  setPcState(pcs[0], 'connected');
  await act(async () => {});

  const say = async (text: string) => {
    const channel = channels[channels.length - 1];
    await act(async () => {
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: text,
        }),
      });
    });
  };
  await say('A');

  // Deux coupures successives, une ligne prononcée après chacune.
  setPcState(pcs[0], 'disconnected');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  setPcState(pcs[pcs.length - 1], 'connected');
  await act(async () => {});
  await say('B');

  setPcState(pcs[pcs.length - 1], 'disconnected');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  setPcState(pcs[pcs.length - 1], 'connected');
  await act(async () => {});
  await say('C');

  await act(async () => {
    await latest!.end();
  });
  const endCall = api.mock.calls.find(
    ([path, method]) => path === '/voice/calls/call-1/end' && method === 'POST',
  );
  expect(endCall).toBeTruthy();
  const body = (endCall![2] ?? {}) as { transcript?: string };
  expect(body.transcript).toBe('You: A\nYou: B\nYou: C');
});
