import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
import {
  buildMessageWithAttachments,
  formatChars,
  parseUserMessageWithAttachments,
  type Attachment,
} from '../src/client/attachments';
import { ChatTranscript } from '../src/client/ChatTranscript';

const textOf = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : node && typeof node === 'object' && 'children' in node
        ? textOf((node as { children: unknown }).children)
        : '';

const file = (name: string, textContent: string): Attachment =>
  ({
    id: 'f1',
    name,
    size: textContent.length,
    mime: 'text/plain',
    category: 'text',
    status: 'ready',
    textContent,
  }) as Attachment;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

it('build injecte un en-tête porteur de longueur exacte', () => {
  const content = 'ABC\n```\nfence\n```';
  const msg = buildMessageWithAttachments('résume', [file('note.md', content)]);
  expect(msg).toContain('[Fichier : note.md — 17 car.]');
  const parts = parseUserMessageWithAttachments(msg);
  expect(parts.text).toBe('résume');
  expect(parts.attachments).toHaveLength(1);
  expect(parts.attachments[0].body).toBe(content);
  expect(parts.attachments[0].truncated).toBe(false);
});

it('parse multi-blocs, fences internes et troncature sans perte', () => {
  const big = 'x'.repeat(60_000);
  const msg = buildMessageWithAttachments('brouillon', [
    file('a.txt', '```code\n1\n```'),
    file('gros.txt', big),
  ]);
  const parts = parseUserMessageWithAttachments(msg);
  expect(parts.text).toBe('brouillon');
  expect(parts.attachments).toHaveLength(2);
  expect(parts.attachments[0].body).toBe('```code\n1\n```');
  expect(parts.attachments[1].body.startsWith('x'.repeat(100))).toBe(true);
  expect(parts.attachments[1].truncated).toBe(true);
  expect(parts.attachments[1].chars).toBe(50_031);
});

it('laisse passer les messages sans bloc et les en-têtes invalides', () => {
  expect(parseUserMessageWithAttachments('simple').attachments).toEqual([]);
  const invalid = '[Fichier : x.md — 10 car.]\n```fichier\nab';
  const parts = parseUserMessageWithAttachments(invalid);
  expect(parts.attachments).toHaveLength(0);
  expect(parts.text).toContain('[Fichier : x.md — 10 car.]');
});

it('replie le format historique en meilleur effort', () => {
  const legacy = '[Fichier : vieux.md]\n```\ncorps historique\n``` fin';
  const parts = parseUserMessageWithAttachments(legacy);
  expect(parts.attachments).toHaveLength(1);
  expect(parts.attachments[0].name).toBe('vieux.md');
  expect(parts.attachments[0].body).toBe('corps historique');
  expect(parts.text).toBe('fin');
});

it('formatChars suit la convention FR', () => {
  expect(formatChars(999)).toBe('999 car.');
  expect(formatChars(12_345)).toBe('12,3k car.');
});

it('la bulle utilisateur affiche brouillon + puces, contenu replié', async () => {
  const msg = buildMessageWithAttachments('ma demande', [
    file('rapport.md', 'contenu complet brut'),
  ]);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(ChatTranscript, {
        messages: [{ id: 'm1', role: 'user', content: msg }],
        calls: [],
      }),
    );
  });
  const tree = root.toJSON();
  const flat = textOf(tree);
  expect(flat).toContain('ma demande');
  expect(flat).toContain('rapport.md');
  expect(flat).toContain('20 car.');
  const details = root.root.findAllByType('details');
  expect(details).toHaveLength(1);
  expect(textOf(details[0].findByType('pre').children)).toBe(
    'contenu complet brut',
  );
});
