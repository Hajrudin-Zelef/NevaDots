import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatTranscript,
  isInternalVoiceReceipt,
} from '../src/client/ChatTranscript';
import type { Message } from '@ag-ui/core';
import { deriveTurnStatus } from '../src/client/turn-status';
import {
  isUserTextFoldable,
  parseLineHeightPx,
  userTextFoldMaxHeightPx,
} from '../src/client/user-message-fold';
it('keeps call receipts between the anchored message and later conversation turns', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'before', role: 'user', content: 'Before the call' },
        { id: 'after', role: 'assistant', content: 'Later message' },
      ]}
      calls={[
        {
          id: 'call',
          threadId: 'thread',
          status: 'ended',
          startedAt: 1000,
          endedAt: 6000,
          transcript: '',
          error: null,
          anchorMessageId: 'before',
        },
      ]}
    />,
  );
  expect(html.indexOf('Before the call')).toBeLessThan(
    html.indexOf('Call ended'),
  );
  expect(html.indexOf('Call ended')).toBeLessThan(
    html.indexOf('Later message'),
  );
});

it('renders tool-only assistant messages inline between chat turns without printing tool JSON', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Open the website' },
        {
          id: 'tool-call',
          role: 'assistant',
          toolCalls: [
            {
              id: 'navigate',
              type: 'function',
              function: {
                name: 'computer_navigate',
                arguments: '{"url":"https://example.com"}',
              },
            },
          ],
        },
        { id: 'reply', role: 'assistant', content: 'Here is the summary' },
      ]}
      calls={[]}
      renderTools={(message) =>
        message.toolCalls?.length ? (
          <section>Inline computer view</section>
        ) : null
      }
    />,
  );
  expect(html.indexOf('Open the website')).toBeLessThan(
    html.indexOf('Inline computer view'),
  );
  expect(html.indexOf('Inline computer view')).toBeLessThan(
    html.indexOf('Here is the summary'),
  );
  expect(html).not.toContain('undefined');
  expect(html).not.toContain('computer_navigate');
});

it('visually labels scheduled prompts while keeping ordinary user messages unchanged', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'manual', role: 'user', content: 'Manual request' },
        {
          id: 'opendots:scheduled_task:run-1',
          role: 'user',
          content: 'Scheduled request body',
        },
        {
          id: 'opendots:scheduled_task:assistant',
          role: 'assistant',
          content: 'Scheduled request body',
          metadata: { opendotsSource: 'scheduled_task' },
        },
      ]}
      calls={[]}
    />,
  );

  expect(html).toContain('Manual request');
  expect(html).toContain('Scheduled request body');
  expect(html).toContain('Scheduled');
  expect(html).toContain('chat-bubble user scheduled');
  expect(html).toContain(
    '<div class="chat-bubble user"><div class="user-text"><p>Manual request</p></div></div>',
  );
  expect(html).toContain('chat-bubble assistant');
  expect(html.match(/Scheduled request body/g)).toHaveLength(2);
  expect(html.match(/scheduled-message-label/g)).toHaveLength(1);
});

it('labels a scheduled prompt from metadata without requiring a prefixed ID', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        {
          id: 'scheduled',
          role: 'user',
          content: 'Metadata-marked scheduled prompt',
          metadata: { opendotsSource: 'scheduled_task' },
        },
      ]}
      calls={[]}
    />,
  );
  expect(html).toContain('scheduled-message-label');
  expect(html).toContain('Metadata-marked scheduled prompt');
});

it('retains the scheduled label when history replay provides only the durable message ID', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        {
          id: 'opendots:scheduled_task:replayed',
          role: 'user',
          content: 'Replayed scheduled prompt',
        },
      ]}
      calls={[]}
    />,
  );

  expect(html).toContain('Scheduled');
  expect(html).toContain('Replayed scheduled prompt');
  expect(html).toContain('chat-bubble user scheduled');
});

it('hides only marked receipt prompts while retaining summaries and prior unmarked messages', () => {
  const messages: Message[] = [
    { id: 'legacy', role: 'user', content: 'Earlier unmarked receipt prompt' },
    {
      id: 'internal',
      role: 'user',
      content: 'Internal sync instructions',
      metadata: { opendotsSource: 'voice_receipt' },
    },
    {
      id: 'opendots:voice_receipt:durable',
      role: 'user',
      content: 'Persisted internal instructions without metadata',
    },
    {
      id: 'summary',
      role: 'assistant',
      content: 'Confirmed call summary',
      metadata: { opendotsSource: 'voice_receipt' },
    },
    {
      id: 'user',
      role: 'user',
      content: 'My next question',
      metadata: { opendotsSource: 'voice_compute' },
    },
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={messages.filter((message) => !isInternalVoiceReceipt(message))}
      calls={[]}
    />,
  );
  expect(html).not.toContain('Internal sync instructions');
  expect(html).not.toContain(
    'Persisted internal instructions without metadata',
  );
  expect(html).toContain('Earlier unmarked receipt prompt');
  expect(html).toContain('Confirmed call summary');
  expect(html).toContain('My next question');
});

it('rend les outils AVANT le texte assistant (lot 3 : tour = outils puis texte)', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Liste les fichiers' },
        {
          id: 'reply',
          role: 'assistant',
          content: 'Voici la liste.',
          toolCalls: [
            {
              id: 'list',
              type: 'function',
              function: { name: 'computer_list', arguments: '{}' },
            },
          ],
        },
      ]}
      calls={[]}
      renderTools={(message) =>
        message.toolCalls?.length ? (
          <section>Inline computer view</section>
        ) : null
      }
    />,
  );
  expect(html.indexOf('Inline computer view')).toBeLessThan(
    html.indexOf('Voici la liste.'),
  );
});

it('ancre la carte live au tour en cours : avant le texte du dernier message assistant', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Question' },
        { id: 'reply', role: 'assistant', content: 'Réponse en cours' },
      ]}
      calls={[]}
      running
      liveSteps={[{ id: 's1', label: 'Lecture', status: 'running' }]}
      thinkingLabel="Dot is thinking"
    />,
  );
  expect(html).toContain('Lecture…');
  expect(html.indexOf('Lecture…')).toBeLessThan(
    html.indexOf('Réponse en cours'),
  );
});

it('ancre le live après la bulle user quand le tour n’a pas encore de message assistant', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[{ id: 'request', role: 'user', content: 'Question' }]}
      calls={[]}
      running
      liveSteps={[{ id: 's1', label: 'Lecture', status: 'running' }]}
      thinkingLabel="Dot is thinking"
    />,
  );
  expect(html.indexOf('Question')).toBeLessThan(html.indexOf('Lecture…'));
});

it('n’ancre jamais le live au tour précédent : un message user plus récent le reprend', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'old-reply', role: 'assistant', content: 'Ancienne réponse' },
        { id: 'request', role: 'user', content: 'Nouvelle question' },
      ]}
      calls={[]}
      running
      liveSteps={[{ id: 's1', label: 'Lecture', status: 'running' }]}
      thinkingLabel="Dot is thinking"
    />,
  );
  expect(html.indexOf('Ancienne réponse')).toBeLessThan(
    html.indexOf('Nouvelle question'),
  );
  expect(html.indexOf('Nouvelle question')).toBeLessThan(
    html.indexOf('Lecture…'),
  );
});

it('affiche la ligne de statut sous le tour en cours, jamais à l’arrêt', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[{ id: 'request', role: 'user', content: 'Question' }]}
      calls={[]}
      running
      statusLabel="Travail en cours"
    />,
  );
  expect(html).toContain('Travail en cours');
  expect(html).toContain('turn-status');
  const idle = renderToStaticMarkup(
    <ChatTranscript
      messages={[{ id: 'request', role: 'user', content: 'Question' }]}
      calls={[]}
      statusLabel={null}
    />,
  );
  expect(idle).not.toContain('turn-status');
});

it('dérive la ligne de statut des appels en attente (approbation, réponse, shell)', () => {
  const toolCall = (id: string, name: string) => ({
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  });
  const assistantWith = (calls: unknown[]) =>
    [
      { id: 'request', role: 'user', content: 'Fais-le' },
      { id: 'reply', role: 'assistant', content: '', toolCalls: calls },
    ] as unknown as Message[];
  const answered = (id: string) => ({
    id: `tool-${id}`,
    role: 'tool',
    toolCallId: id,
    content: 'ok',
  });

  expect(deriveTurnStatus([], true)).toBe('working');
  expect(deriveTurnStatus(assistantWith([]), true)).toBe('working');
  expect(deriveTurnStatus(assistantWith([]), false)).toBeNull();
  expect(
    deriveTurnStatus(
      assistantWith([toolCall('c1', 'review_space_page')]),
      true,
    ),
  ).toBe('approval');
  expect(
    deriveTurnStatus(
      assistantWith([toolCall('c1', 'request_connection_action')]),
      true,
    ),
  ).toBe('answer');
  expect(
    deriveTurnStatus(assistantWith([toolCall('c1', 'computer_exec')]), true),
  ).toBe('shell');
  // Appel répondu : le tour ne l’attend plus.
  expect(
    deriveTurnStatus(
      [
        ...assistantWith([toolCall('c1', 'computer_exec')]),
        answered('c1'),
      ] as unknown as Message[],
      true,
    ),
  ).toBe('working');
  // Priorité : l’approbation passe avant le shell.
  expect(
    deriveTurnStatus(
      assistantWith([
        toolCall('c1', 'computer_exec'),
        toolCall('c2', 'review_space_page'),
      ]),
      true,
    ),
  ).toBe('approval');
  // Priorité : l’approbation passe avant la réponse, quel que soit
  // l’ordre des appels — le libellé ne dépend pas de l’ordre.
  expect(
    deriveTurnStatus(
      assistantWith([
        toolCall('c1', 'request_connection_action'),
        toolCall('c2', 'review_space_page'),
      ]),
      true,
    ),
  ).toBe('approval');
  expect(
    deriveTurnStatus(
      assistantWith([
        toolCall('c1', 'review_space_page'),
        toolCall('c2', 'request_connection_action'),
      ]),
      true,
    ),
  ).toBe('approval');
  // Priorité : la réponse passe avant le shell, dans les deux ordres.
  expect(
    deriveTurnStatus(
      assistantWith([
        toolCall('c1', 'computer_exec'),
        toolCall('c2', 'request_connection_action'),
      ]),
      true,
    ),
  ).toBe('answer');
  expect(
    deriveTurnStatus(
      assistantWith([
        toolCall('c1', 'request_connection_action'),
        toolCall('c2', 'computer_exec'),
      ]),
      true,
    ),
  ).toBe('answer');
});

it('repli utilisateur : 12 lignes déclenchent, 8 sont montrées', () => {
  expect(parseLineHeightPx('21px', 14)).toBe(21);
  expect(parseLineHeightPx('150%', 14)).toBe(21);
  expect(parseLineHeightPx('normal', 14)).toBeNull();
  expect(parseLineHeightPx('abc', 14)).toBeNull();
  // 12 lignes exactement (252 px à 21 px/ligne) : pas de repli.
  expect(isUserTextFoldable(252, 21)).toBe(false);
  expect(isUserTextFoldable(252.4, 21)).toBe(false);
  expect(isUserTextFoldable(253, 21)).toBe(true);
  expect(userTextFoldMaxHeightPx(21)).toBe(168);
});

it('sans DOM (rendu serveur), le texte user ne se replie pas — pas de « Voir plus »', () => {
  const longText = Array.from({ length: 20 }, (_, i) => `Ligne ${i + 1}`).join(
    '\n',
  );
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[{ id: 'long', role: 'user', content: longText }]}
      calls={[]}
    />,
  );
  expect(html).toContain('Ligne 20');
  expect(html).not.toContain('Voir plus');
  expect(html).toContain('user-text');
});
