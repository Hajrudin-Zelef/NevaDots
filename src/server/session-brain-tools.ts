import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { SessionBrainStore } from './session-brain.js';

const READ_LIMIT_CHARS = 6_000;

export interface SessionBrainToolScope {
  userId: string;
  dotId: string;
  threadId: string;
}

/**
 * Outils du cerveau de session. Les notes sont isolées au thread courant et
 * ne donnent aucun accès au cerveau Operator de développement.
 */
export function sessionBrainTools(
  store: SessionBrainStore,
  scope: SessionBrainToolScope,
  check: () => void,
) {
  return [
    defineTool({
      name: 'session_brain_note',
      description:
        'Append one concise, durable note to this chat session (decisions, facts, file names, URLs, open threads). Notes survive context compaction and stay isolated to this session. Never store secrets. Keep each note short.',
      parameters: z.object({
        note: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe('One essential fact or decision to remember.'),
      }),
      execute: async ({ note }: { note: string }) => {
        check();
        return store.append(scope, note);
      },
    }),
    defineTool({
      name: 'session_brain_read',
      description:
        'Read the full notes for this chat session. Use it when the prompt shows truncated notes or before rewriting them.',
      parameters: z.object({}),
      execute: async () => {
        check();
        const notes = await store.read(scope);
        return {
          notes: notes.slice(0, READ_LIMIT_CHARS),
          truncated: notes.length > READ_LIMIT_CHARS,
          bytes: Buffer.byteLength(notes, 'utf8'),
        };
      },
    }),
    defineTool({
      name: 'session_brain_write',
      description:
        'Replace the notes for this chat session with a compact Markdown version. Use it only to remove duplicates or merge notes when the limit is reached. Notes are isolated to this session.',
      parameters: z.object({
        content: z
          .string()
          .max(32_768)
          .describe('Complete compact Markdown notes for this session.'),
      }),
      execute: async ({ content }: { content: string }) => {
        check();
        return store.write(scope, content);
      },
    }),
  ];
}
