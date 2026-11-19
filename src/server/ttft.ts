/**
 * Garde « premier token » (TTFT) pour les appels modèle en streaming.
 *
 * Un modèle lourd peut mettre une minute avant le premier morceau. On lit le
 * premier morceau avec un délai borné ; s'il n'arrive pas, on annule le flux
 * pour rejouer la requête sur un modèle de secours plus rapide.
 *
 * Le flux est reconstruit (premier morceau déjà lu + le reste) sans toucher
 * aux octets : le parseur SSE du client reçoit exactement le même contenu.
 */

export type FirstChunk =
  | {
      kind: 'chunk';
      value: Uint8Array;
      reader: ReadableStreamDefaultReader<Uint8Array>;
    }
  | { kind: 'done'; reader: ReadableStreamDefaultReader<Uint8Array> }
  | { kind: 'timeout' }
  | { kind: 'none' };

/**
 * Attend le premier morceau du corps pendant au plus `ms`.
 * En cas de timeout, le flux est annulé et `timeout` est retourné.
 */
export async function readFirstChunk(
  response: Response,
  ms: number,
): Promise<FirstChunk> {
  if (!response.body) return { kind: 'none' };
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((chunk) => ({ kind: 'read' as const, chunk })),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
    if (result === 'timeout') {
      await reader.cancel().catch(() => {});
      return { kind: 'timeout' };
    }
    if (result.chunk.done) return { kind: 'done', reader };
    return { kind: 'chunk', value: result.chunk.value, reader };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reconstruit une réponse dont le premier morceau a déjà été lu.
 * `content-encoding`/`content-length` sont retirés : le corps de `fetch` est
 * déjà décompressé, les conserver provoquerait une double décompression.
 */
export function rebuildResponse(
  response: Response,
  first: FirstChunk,
): Response {
  if (first.kind === 'none') return response;
  if (first.kind === 'timeout') throw new Error('ttft-timeout');
  const reader = first.reader;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.kind === 'done') controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
