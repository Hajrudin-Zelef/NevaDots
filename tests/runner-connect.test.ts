import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it } from 'vitest';
import { ɵGLOBAL_STORE } from '@copilotkit/runtime/v2';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';

/**
 * Connexion d'un client à un thread : le runner émet un snapshot de messages
 * (idempotent) au lieu de rejouer tous les événements passés. Le rejeu
 * concaténait les deltas de texte sur les messages déjà présents — « réponse
 * en double » — et devenait coûteux sur un long historique.
 */

const runners: SqliteAgentRunner[] = [];
afterEach(() => {
  runners.splice(0).forEach((runner) => runner.close());
});

const store = ɵGLOBAL_STORE as unknown as {
  getOrCreate(threadId: string): unknown;
  peek(threadId: string): { messagesSnapshot: unknown[] } | undefined;
  appendRun(threadId: string, run: unknown): void;
};

it('émet un snapshot de messages, pas un replay d’événements', async () => {
  const threadId = `snapshot-${Date.now()}`;
  const messages = [
    { id: 'u1', role: 'user', content: 'Salut' },
    { id: 'a1', role: 'assistant', content: 'Bonjour.' },
  ];
  store.getOrCreate(threadId);
  store.appendRun(threadId, {
    runId: 'run-1',
    agentId: 'dot-1',
    parentRunId: null,
    // Des événements existent : ils ne doivent PAS être rejoués.
    events: [
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Bonjour.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
    ],
    messages,
    createdAt: Date.now(),
  });

  const runner = new SqliteAgentRunner(':memory:');
  runners.push(runner);
  const events = await firstValueFrom(
    runner.connect({ threadId }).pipe(toArray()),
  );

  expect(events).toHaveLength(1);
  const snapshot = events[0] as { type: string; messages: unknown[] };
  expect(snapshot.type).toBe('MESSAGES_SNAPSHOT');
  expect(snapshot.messages).toEqual(messages);
  expect(store.peek(threadId)?.messagesSnapshot).toEqual(messages);
});

it('thread inconnu : snapshot vide puis fin de flux', async () => {
  const runner = new SqliteAgentRunner(':memory:');
  runners.push(runner);
  const events = await firstValueFrom(
    runner.connect({ threadId: `vide-${Date.now()}` }).pipe(toArray()),
  );
  expect(events).toHaveLength(1);
  expect((events[0] as unknown as { messages: unknown[] }).messages).toEqual(
    [],
  );
});
