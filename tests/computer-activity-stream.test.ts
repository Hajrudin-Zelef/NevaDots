import { afterEach, expect, it, vi } from 'vitest';
import type { ComputerActivityEvent } from '../src/shared/computer-types';
import {
  computerActivitySnapshot,
  subscribeComputerActivity,
} from '../src/client/useComputerActivity';

afterEach(() => vi.unstubAllGlobals());

it('partage un seul flux NDJSON entre le rail et le panneau ordinateur', async () => {
  const dotId = 'shared-stream-test';
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const railUpdates = vi.fn();
  const paneUpdates = vi.fn();
  const agentStarts = vi.fn();
  const releaseRail = subscribeComputerActivity(
    dotId,
    railUpdates,
    agentStarts,
  );
  const releasePane = subscribeComputerActivity(dotId, paneUpdates);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const start: ComputerActivityEvent = {
    dotId,
    action: 'exec',
    actor: 'agent',
    phase: 'start',
    at: 1,
    command: 'npm test',
  };
  controller?.enqueue(encoder.encode(`${JSON.stringify(start)}\n`));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(computerActivitySnapshot(dotId).runs).toMatchObject([
    { actor: 'agent', command: 'npm test', running: true },
  ]);
  expect(railUpdates).toHaveBeenCalled();
  expect(paneUpdates).toHaveBeenCalled();
  expect(agentStarts).toHaveBeenCalledTimes(1);

  releaseRail();
  expect(computerActivitySnapshot(dotId).connected).toBe(true);
  releasePane();
  expect(computerActivitySnapshot(dotId).connected).toBe(false);
});

it('isole les connexions et le journal par Dot', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const releaseA = subscribeComputerActivity('stream-dot-a', () => {});
  const releaseB = subscribeComputerActivity('stream-dot-b', () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(computerActivitySnapshot('stream-dot-a').runs).toEqual([]);
  expect(computerActivitySnapshot('stream-dot-b').runs).toEqual([]);
  releaseA();
  releaseB();
});
