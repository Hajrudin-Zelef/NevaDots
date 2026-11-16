import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

const PROVIDERS: PlatformConfig['providers'] = [
  {
    id: 'alpha',
    label: 'Alpha',
    baseUrl: 'https://alpha.invalid/v1',
    apiKey: 'key-alpha',
    models: ['model-alpha'],
  },
  {
    id: 'beta',
    label: 'Beta',
    baseUrl: 'https://beta.invalid/v1',
    apiKey: 'key-beta',
    models: ['model-beta'],
  },
];

function fixture() {
  const store = new Store(':memory:').forUser('owner');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.ensureSeed();
  databases.push(store, workspace);
  const seed = workspace.dots()[0];
  workspace.setDotModel(seed.id, 'alpha', 'model-alpha');
  const dot = workspace.dot(seed.id)!;
  workspace.bindThread('thread', dot.id, 'Bascule');
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fallback',
      model: 'fallback-model',
      baseUrl: 'https://fallback.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      providers: PROVIDERS,
    },
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    messages: [{ id: 'user', role: 'user', content: 'Salut' }],
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
  };
  return { store, workspace, dot, agent, input };
}

it('bascule sur le modèle courant quand le provider renvoie une erreur API', async () => {
  const f = fixture();
  const calls: Array<{ url: string; model: string }> = [];
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { model?: string })
        : {};
      calls.push({ url, model: String(body.model) });
      if (url.startsWith('https://alpha.invalid')) {
        // Le tour est parti sur alpha ; l'utilisateur bascule sur beta
        // pendant la requête (clé morte, quota épuisé…).
        f.workspace.setDotModel(f.dot.id, 'beta', 'model-beta');
        return new Response('{"error":"invalid api key"}', { status: 401 });
      }
      return completion({ role: 'assistant', content: 'Bonjour.' });
    });

  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));

  expect(
    events.some((event) => event.type === EventType.RUN_ERROR),
    'aucune erreur visible',
  ).toBe(false);
  const text = events
    .filter(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT ||
        event.type === EventType.TEXT_MESSAGE_CHUNK,
    )
    .map((event) => String((event as { delta?: string }).delta ?? ''))
    .join('');
  expect(text).toBe('Bonjour.');

  // Deux appels : alpha refusé, puis beta avec le MÊME historique.
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({
    url: 'https://alpha.invalid/v1/chat/completions',
    model: 'model-alpha',
  });
  expect(calls[1]).toEqual({
    url: 'https://beta.invalid/v1/chat/completions',
    model: 'model-beta',
  });
  const retried = JSON.parse(String(network.mock.calls[1][1]?.body)) as {
    messages: Array<{ content: string }>;
  };
  expect(retried.messages.at(-1)?.content).toContain('Salut');
});

it('reste sur le modèle du tour quand le Dot ne change pas', async () => {
  const f = fixture();
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(String(input));
    return completion({ role: 'assistant', content: 'Ok.' });
  });
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(calls).toEqual(['https://alpha.invalid/v1/chat/completions']);
});
