import { describe, expect, it } from 'vitest';
import {
  pushPendingScreenshot,
  takePendingScreenshots,
} from '../src/server/computer-screenshots';
import { screenshotMiddleware } from '../src/server/screenshot-middleware';

describe('computer-screenshots (phase 5a)', () => {
  it('push/take : FIFO par dot, vide après consommation', () => {
    pushPendingScreenshot('dot-a', 'base64-1');
    pushPendingScreenshot('dot-a', 'base64-2');
    pushPendingScreenshot('dot-b', 'base64-3');
    expect(takePendingScreenshots('dot-a')).toEqual(['base64-1', 'base64-2']);
    expect(takePendingScreenshots('dot-a')).toEqual([]);
    expect(takePendingScreenshots('dot-b')).toEqual(['base64-3']);
  });
});

describe('screenshot-middleware (phase 5a)', () => {
  it('injecte les screenshots en attente comme messages image', () => {
    pushPendingScreenshot('dot-mw', 'aGVsbG8=');
    const mw = screenshotMiddleware('dot-mw');
    const config = { messages: [{ role: 'user', content: 'hello' }] };
    const result = mw.onConfig?.({} as never, config as never) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(result.messages).toHaveLength(2);
    const injected = result.messages[1];
    expect(injected.role).toBe('user');
    expect(injected.content).toEqual([
      {
        type: 'image',
        source: {
          type: 'data',
          value: 'aGVsbG8=',
          mimeType: 'image/png',
        },
      },
    ]);
    // Consommés : deuxième appel ne réinjecte pas.
    const again = mw.onConfig?.({} as never, config as never);
    expect(again).toBeUndefined();
  });

  it('laisse passer quand aucun screenshot en attente', () => {
    const mw = screenshotMiddleware('dot-empty');
    const config = { messages: [] };
    expect(mw.onConfig?.({} as never, config as never)).toBeUndefined();
  });
});
