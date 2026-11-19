import { describe, expect, it } from 'vitest';
import { readFirstChunk, rebuildResponse } from '../src/server/ttft';

function streamOf(
  chunks: Uint8Array[],
  delayMs = 0,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('ttft guard', () => {
  it('lit le premier morceau et reconstruit la réponse complète', async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      streamOf([encoder.encode('data: a\n\n'), encoder.encode('data: b\n\n')]),
      {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': '99',
        },
      },
    );
    const first = await readFirstChunk(response, 1000);
    expect(first.kind).toBe('chunk');
    const rebuilt = rebuildResponse(response, first);
    await expect(rebuilt.text()).resolves.toBe('data: a\n\ndata: b\n\n');
    expect(rebuilt.headers.get('content-encoding')).toBeNull();
    expect(rebuilt.headers.get('content-length')).toBeNull();
  });

  it('retourne timeout quand le premier morceau arrive trop tard', async () => {
    const response = new Response(streamOf([new Uint8Array([1])], 200));
    const first = await readFirstChunk(response, 20);
    expect(first.kind).toBe('timeout');
  });

  it('gère un corps vide', async () => {
    const response = new Response(null);
    const first = await readFirstChunk(response, 1000);
    expect(first.kind).toBe('none');
  });

  it('rebuildResponse refuse un timeout', async () => {
    const response = new Response(streamOf([new Uint8Array([1])], 200));
    const first = await readFirstChunk(response, 20);
    expect(() => rebuildResponse(response, first)).toThrow('ttft-timeout');
  });
});
