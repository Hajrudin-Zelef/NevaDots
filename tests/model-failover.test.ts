import { describe, expect, it } from 'vitest';
import {
  retargetChatCompletions,
  sameChatTarget,
  shouldFailover,
  type ChatTarget,
} from '../src/server/model-failover.js';

const target = (over: Partial<ChatTarget> = {}): ChatTarget => ({
  providerId: 'litellm',
  model: 'deepseek-v4',
  apiKey: 'sk-new',
  baseUrl: 'http://127.0.0.1:4000/v1',
  ...over,
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    body: JSON.stringify(body),
    headers: new Headers({ ...headers, 'content-type': 'application/json' }),
  } as RequestInit;
}

describe('bascule à chaud de modèle', () => {
  it('réécrit URL, clé et modèle du corps', () => {
    const moved = retargetChatCompletions(
      request({
        model: 'old-model',
        messages: [{ role: 'user', content: 'x' }],
      }),
      target(),
    );
    expect(moved).not.toBeNull();
    expect(moved?.url).toBe('http://127.0.0.1:4000/v1/chat/completions');
    const headers = new Headers(moved?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-new');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(moved?.init.body)) as {
      model: string;
      messages: unknown[];
    };
    expect(body.model).toBe('deepseek-v4');
    // L'historique du tour ne bouge pas : le nouveau modèle le reçoit tel quel.
    expect(body.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('normalise une baseUrl avec slash final', () => {
    const moved = retargetChatCompletions(
      request({ model: 'a' }),
      target({ baseUrl: 'https://api.example.com/v1/' }),
    );
    expect(moved?.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('ne touche pas une requête non réécrivable', () => {
    expect(retargetChatCompletions(undefined, target())).toBeNull();
    expect(
      retargetChatCompletions({ body: 'pas du json' } as RequestInit, target()),
    ).toBeNull();
    expect(
      retargetChatCompletions(
        { body: new Blob(['x']) } as unknown as RequestInit,
        target(),
      ),
    ).toBeNull();
  });

  it('classe les statuts qui justifient une bascule', () => {
    for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 503])
      expect(shouldFailover(status), String(status)).toBe(true);
    for (const status of [200, 201, 204, 301, 413])
      expect(shouldFailover(status), String(status)).toBe(false);
  });

  it('compare les cibles', () => {
    expect(sameChatTarget(target(), target())).toBe(true);
    expect(sameChatTarget(target(), target({ model: 'autre' }))).toBe(false);
    expect(sameChatTarget(target(), target({ apiKey: 'sk-2' }))).toBe(false);
    expect(
      sameChatTarget(target(), target({ baseUrl: 'http://autre/v1' })),
    ).toBe(false);
  });
});
