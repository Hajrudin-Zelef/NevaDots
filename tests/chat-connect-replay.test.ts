import { describe, expect, it } from 'vitest';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';

/**
 * Garde-fou du bug « 2 réponses identiques » : le `connect` du runtime
 * rejoue tous les événements du thread. AG-UI ré-applique les deltas sur
 * les messages déjà présents (seul `TEXT_MESSAGE_START` se déduplique par
 * id), donc un second connect sans remise à zéro concatène la réponse avec
 * elle-même. `Chat.tsx` remet les messages à zéro avant chaque connect ;
 * ce test fixe le comportement de la bibliothèque pour que la garde ne
 * puisse pas être retirée sans que la CI le voie.
 */

const THREAD = 'thread-1';

function replayEvents() {
  return [
    { type: 'RUN_STARTED', threadId: THREAD, runId: 'run-1' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'Bonjour, voici la réponse.',
    },
    { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
    { type: 'RUN_FINISHED', threadId: THREAD, runId: 'run-1' },
  ];
}

function agent() {
  const body = replayEvents()
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new ProxiedCopilotRuntimeAgent({
    runtimeUrl: 'http://runtime.test/api/copilotkit',
    agentId: 'chat-test',
    runtimeAgentId: 'dot-test',
    threadId: THREAD,
    transport: 'rest',
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
}

const assistantContents = (a: ProxiedCopilotRuntimeAgent) =>
  a.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => String(message.content));

describe('replay de connexion', () => {
  it('sans remise à zéro, un second connect double le contenu', async () => {
    const a = agent();
    await a.connectAgent();
    expect(assistantContents(a)).toEqual(['Bonjour, voici la réponse.']);
    await a.connectAgent();
    expect(assistantContents(a)).toEqual([
      'Bonjour, voici la réponse.Bonjour, voici la réponse.',
    ]);
  });

  it('avec remise à zéro (ce que fait Chat), le contenu reste unique', async () => {
    const a = agent();
    await a.connectAgent();
    a.setMessages([]);
    await a.connectAgent();
    expect(assistantContents(a)).toEqual(['Bonjour, voici la réponse.']);
    expect(a.messages).toHaveLength(1);
  });
});
