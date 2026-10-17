import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  ATTACHMENTS_DIR,
  categorizeAttachment,
  type AttachmentMeta,
} from './attachment-routes.js';

/** Taille max d'un fichier généré : le modèle produit du texte. */
const MAX_GENERATED_SIZE = 5 * 1024 * 1024; // 5 Mo

/** MIME par extension pour les fichiers générés (contenu texte UTF-8). */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  sh: 'text/x-sh; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  xml: 'text/xml; charset=utf-8',
};

/**
 * Nom de fichier assaini : basename uniquement (pas de chemin, pas de
 * traversal), caractères sûrs, longueur bornée.
 */
export function sanitizeGeneratedFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || 'fichier.txt';
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  return clean || 'fichier.txt';
}

/**
 * Sauvegarde un fichier généré par l'agent dans le circuit des pièces
 * jointes (data/attachments/<uuid>/) : réutilise le download, la
 * prévisualisation et le nettoyage TTL existants.
 */
export async function saveGeneratedFile(
  filename: string,
  content: string,
): Promise<AttachmentMeta> {
  const name = sanitizeGeneratedFilename(filename);
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_GENERATED_SIZE) {
    throw new Error(
      `Contenu trop volumineux (max 5 Mo) : ${(buffer.length / 1024 / 1024).toFixed(1)} Mo.`,
    );
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_BY_EXT[ext] ?? 'text/plain; charset=utf-8';
  const id = randomUUID();
  const dir = join(ATTACHMENTS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'file'), buffer);
  const meta: AttachmentMeta = {
    id,
    name,
    size: buffer.length,
    mime,
    category: categorizeAttachment(mime, name),
    createdAt: Date.now(),
    // Le fichier généré est rattaché au fil dès sa création : il ne doit
    // jamais être emporté par le sweep des orphelins (7 j).
    attachedAt: Date.now(),
  };
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

/** Taille max d'un binaire produit par l'agent (PDF/DOCX…) : alignée sur l'upload. */
export const MAX_BINARY_SIZE = 50 * 1024 * 1024; // 50 Mo

/**
 * Sauvegarde un fichier binaire produit par l'agent (PDF édité/OCRé,
 * DOCX…) dans le circuit des pièces jointes, avec les mêmes garanties
 * que saveGeneratedFile (download, aperçu, jamais emporté par le sweep).
 */
export async function saveBinaryAttachment(
  filename: string,
  buffer: Buffer,
  mime: string,
): Promise<AttachmentMeta> {
  const name = sanitizeGeneratedFilename(filename);
  if (buffer.length > MAX_BINARY_SIZE) {
    throw new Error(
      `Fichier trop volumineux (max 50 Mo) : ${(buffer.length / 1024 / 1024).toFixed(1)} Mo.`,
    );
  }
  const id = randomUUID();
  const dir = join(ATTACHMENTS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'file'), buffer);
  const meta: AttachmentMeta = {
    id,
    name,
    size: buffer.length,
    mime,
    category: categorizeAttachment(mime, name),
    createdAt: Date.now(),
    attachedAt: Date.now(),
  };
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}
/** Outil agent : générer un fichier texte téléchargeable. */
export function generateFileTool() {
  return [
    defineTool({
      name: 'generate_file',
      description:
        'Generate a text file (document, code, CSV, Markdown, etc.) and make it downloadable. The file is saved server-side; use the returned downloadUrl to present a Markdown download link to the user. Use this whenever the user asks for a file.',
      parameters: z.object({
        filename: z
          .string()
          .min(1)
          .max(100)
          .describe(
            'File name with extension, e.g. "rapport.md", "script.py", "data.csv".',
          ),
        content: z
          .string()
          .min(1)
          .max(MAX_GENERATED_SIZE)
          .describe('Full UTF-8 text content of the file.'),
      }),
      execute: async ({
        filename,
        content,
      }: {
        filename: string;
        content: string;
      }) => {
        const meta = await saveGeneratedFile(filename, content);
        return {
          id: meta.id,
          name: meta.name,
          size: meta.size,
          downloadUrl: `/api/attachments/${meta.id}/content?download=1`,
        };
      },
    }),
  ];
}
