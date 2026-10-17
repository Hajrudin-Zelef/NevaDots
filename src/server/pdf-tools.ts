import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { attachmentDir, readMeta } from './attachment-routes.js';
import { pushPendingScreenshot } from './computer-screenshots.js';

/**
 * read_pdf (plan OffLineFork/nevadots-read-pdf-plan.md) : rend les PDFs
 * joints lisibles par le Dot via pdfcraft-cli. On-demand pur : rien n'est
 * extrait à l'upload ; le modèle choisit pages et mode.
 */

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Plafonds : le texte complet d'un PDF ne doit jamais inonder le prompt. */
const TEXT_PAGE_CAP = 10;
const IMAGE_PAGE_CAP = 3;
const TEXT_BUDGET = 12_000;
const CLI_TIMEOUT_MS = 15_000;

export function pdfcraftCliPath(): string {
  return process.env.PDFCRAFT_CLI_PATH ?? '/home/sam/.local/bin/pdfcraft-cli';
}

function runCli(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      pdfcraftCliPath(),
      args,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(stderr?.trim().slice(0, 300) || err.message || 'cli'),
          );
        else resolve(stdout);
      },
    );
  });
}

/** "1", "1-5", "2,4" → [1..5] ; null si invalide ou > cap. */
export function parsePageSpec(spec: string, cap: number): number[] | null {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (start < 1 || end < start) return null;
    for (let n = start; n <= end; n++) out.push(n);
    if (new Set(out).size > cap) return null;
  }
  return out.length ? [...new Set(out)] : null;
}

/** Résout un PDF joint : UUID strict, dossier sous data/attachments, catégorie pdf. */
export async function resolvePdf(attachmentId: string): Promise<string> {
  if (!UUID_RE.test(attachmentId))
    throw new Error('Identifiant de pièce jointe invalide.');
  const meta = await readMeta(attachmentId);
  if (!meta) throw new Error('Pièce jointe introuvable.');
  if (meta.category !== 'pdf')
    throw new Error(`« ${meta.name} » n'est pas un PDF.`);
  const path = join(attachmentDir(attachmentId), 'file');
  if (!existsSync(path)) throw new Error('Fichier PDF absent du stockage.');
  return path;
}

export interface ReadPdfInput {
  attachmentId: string;
  pages?: string;
  mode?: 'text' | 'images';
}

export async function readPdfAttachment(
  dotId: string,
  input: ReadPdfInput,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { attachmentId, pages = '1', mode = 'text' } = input;
  const pdfPath = await resolvePdf(attachmentId);
  const selection = parsePageSpec(
    pages,
    mode === 'images' ? IMAGE_PAGE_CAP : TEXT_PAGE_CAP,
  );
  if (!selection)
    throw new Error(
      `Sélection de pages invalide (${pages}) — max ${
        mode === 'images' ? IMAGE_PAGE_CAP : TEXT_PAGE_CAP
      } pages, format "1", "1-5" ou "2,4".`,
    );
  if (mode === 'images') {
    let sent = 0;
    for (const page of selection) {
      const out = join(tmpdir(), `nevadots-pdf-${crypto.randomUUID()}.png`);
      try {
        await runCli(
          [
            'render',
            pdfPath,
            '--page',
            String(page),
            '--dpi',
            '110',
            '--out',
            out,
          ],
          signal,
        );
        const png = await fs.readFile(out);
        pushPendingScreenshot(dotId, png.toString('base64'));
        sent++;
      } finally {
        await fs.rm(out, { force: true }).catch(() => {});
      }
    }
    return {
      pagesTransmises: sent,
      note: 'images à la vue du modèle au prochain tour',
    };
  }
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  for (const page of selection) {
    const text = (
      await runCli(['text', pdfPath, '--page', String(page)], signal)
    ).replace(/\s+$/, '');
    if (used + text.length > TEXT_BUDGET) {
      chunks.push(text.slice(0, Math.max(0, TEXT_BUDGET - used)));
      truncated = true;
      break;
    }
    chunks.push(text);
    used += text.length;
  }
  const body = chunks.join('\n\n');
  return {
    pages: selection,
    text: truncated
      ? `${body}\n…[tronqué à ${TEXT_BUDGET} caractères — demander les pages suivantes si besoin]`
      : body,
  };
}

export function pdfTools(dotId: string, signal?: AbortSignal) {
  if (!existsSync(pdfcraftCliPath())) return [];
  return [
    defineTool({
      name: 'read_pdf',
      description:
        'Read a PDF attachment referenced in the conversation ("[PDF joint … — id: …]"). mode "text" extracts reading-order text for the requested pages; mode "images" renders those pages and transmits them to you as pictures (use for scans, diagrams, layout questions). Pages: "1", "1-5" or "2,4" — max 10 pages (text) / 3 pages (images).',
      parameters: z.object({
        attachmentId: z
          .string()
          .regex(UUID_RE)
          .describe('The attachment id from the [PDF joint …] marker.'),
        pages: z
          .string()
          .optional()
          .describe('Page selection, e.g. "2" or "1-5" or "3,7". Default "1".'),
        mode: z
          .enum(['text', 'images'])
          .optional()
          .describe('text (default) or images (visual reading).'),
      }),
      execute: async (input: ReadPdfInput) =>
        readPdfAttachment(dotId, input, signal),
    }),
  ];
}
