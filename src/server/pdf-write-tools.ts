import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { readMeta, type AttachmentMeta } from './attachment-routes.js';
import {
  parsePageSpec,
  pdfcraftCliPath,
  resolvePdf,
  UUID_RE,
} from './pdf-tools.js';
import { saveBinaryAttachment } from './generate-file.js';

/**
 * pdf_edit + pdf_ocr (phase PDF agent, v1) : l'agent modifie les PDFs
 * (jamais en place — toujours un nouveau fichier téléchargeable) et
 * ajoute une couche de texte FR aux scans via ocrmypdf.
 * Même philosophie que read_pdf/generate_file : zod strict, timeouts,
 * confinement sous data/attachments, sorties bornées.
 */

const ATTACHMENTS_DIR = 'data/attachments';
const OCRMYPDF_PATH = () => process.env.OCRMYPDF_PATH ?? '/usr/bin/ocrmypdf';
const EDIT_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 300_000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024; // aligné sur la limite d'upload
const PAGE_CAP = 100;
const OPS_CAP = 8;
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

export function editAvailable(): boolean {
  return existsSync(pdfcraftCliPath());
}

export function ocrAvailable(): boolean {
  return existsSync(OCRMYPDF_PATH());
}

interface PdfcraftStep {
  tool: string;
  args: Record<string, unknown>;
}

function stepErrorText(text: string): string | null {
  const m = /^pdfcraft-cli: step \d+.*$/.exec(text.trim());
  return m ? m[0].slice(0, 400) : null;
}

/**
 * Exécute une session pdfcraft confinée à data/attachments (--root) :
 * sorties limitées au dossier, aucun chemin client, jamais en place.
 * Renvoie les objets JSON de chaque étape (ou throw). La sortie est du
 * JSON pretty-print concaténé sans séparateur : parse incrémental.
 */
async function runPdfcraftScript(
  steps: PdfcraftStep[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const scriptPath = join(tmpdir(), `nevadots-pdf-${randomUUID()}.json`);
  try {
    await fs.writeFile(scriptPath, JSON.stringify(steps));
    const { stdout, stderr } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      execFile(
        pdfcraftCliPath(),
        ['run', '--script', scriptPath, '--root', ATTACHMENTS_DIR],
        { timeout: EDIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          if (err)
            reject(
              new Error(
                stepErrorText(stderr) ||
                  stderr?.trim().slice(0, 400) ||
                  err.message ||
                  'pdfcraft',
              ),
            );
          else resolve({ stdout, stderr });
        },
      );
    });
    const out: Record<string, unknown>[] = [];
    let buffer = '';
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      buffer += (buffer ? '\n' : '') + line;
      let obj: unknown;
      try {
        obj = JSON.parse(buffer);
      } catch {
        continue;
      }
      buffer = '';
      if (obj && typeof obj === 'object' && 'error' in obj)
        throw new Error(String(obj.error ?? 'échec pdfcraft').slice(0, 400));
      out.push(obj as Record<string, unknown>);
    }
    const diagnostics = [stderr, buffer].join('\n');
    const fail = stepErrorText(diagnostics);
    if (fail) throw new Error(fail);
    if (buffer.trim())
      throw new Error(
        `Sortie pdfcraft inattendue : ${buffer.trim().slice(0, 200)}`,
      );
    return out;
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

const pageRange = z.string().min(1).max(60);

const editOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('rotate'),
    pages: pageRange,
    degrees: z
      .union([z.literal(90), z.literal(180), z.literal(270)])
      .default(90),
  }),
  z.object({ op: z.literal('delete'), pages: pageRange }),
  z.object({
    op: z.literal('move'),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
  }),
  z.object({ op: z.literal('extract'), pages: pageRange }),
  z.object({
    op: z.literal('insert_blank'),
    before: z.number().int().min(1),
    count: z.number().int().min(1).max(20).default(1),
  }),
  z.object({
    op: z.literal('metadata'),
    title: z.string().max(200).optional(),
    author: z.string().max(200).optional(),
    subject: z.string().max(200).optional(),
    keywords: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('compress') }),
  z.object({ op: z.literal('to_docx') }),
  z.object({
    op: z.literal('add_text'),
    page: z.number().int().min(1),
    text: z.string().min(1).max(2000),
    x: z.number().min(0).max(2000).default(72),
    y: z.number().min(0).max(2000).default(100),
    size: z.number().min(6).max(72).default(12),
  }),
]);

export type PdfEditOperation = z.input<typeof editOp>;

function parseSelection(
  spec: string,
  pageCount: number,
  label: string,
): number[] {
  const pages = parsePageSpec(spec, PAGE_CAP);
  if (!pages?.length)
    throw new Error(
      `Sélection invalide (${spec}) — format "1", "1-5" ou "2,4".`,
    );
  const bad = pages.find((p) => p > pageCount);
  if (bad !== undefined)
    throw new Error(`Page ${bad} inexistante (${label} : ${pageCount} pages).`);
  return pages;
}

export interface PdfEditInput {
  attachmentId: string;
  operations: PdfEditOperation[];
}

function resultName(
  base: string,
  operations: PdfEditOperation[],
): { name: string; mime: string } {
  if (operations.some((o) => o.op === 'to_docx'))
    return { name: `${base}.docx`, mime: DOCX_MIME };
  if (operations.some((o) => o.op === 'extract'))
    return { name: `${base}-extrait.pdf`, mime: PDF_MIME };
  if (operations.some((o) => o.op === 'compress'))
    return { name: `${base}-compresse.pdf`, mime: PDF_MIME };
  return { name: `${base}-edite.pdf`, mime: PDF_MIME };
}

export async function pdfEditAttachment(
  input: PdfEditInput,
  signal?: AbortSignal,
): Promise<AttachmentMeta> {
  const { attachmentId, operations } = input;
  const absPath = await resolvePdf(attachmentId);
  const size = statSync(absPath).size;
  if (size > MAX_INPUT_BYTES)
    throw new Error('PDF trop volumineux (max 50 Mo).');
  const relIn = `${attachmentId}/file`;
  // Phase A : sonde (nombre de pages, chiffrement) — bon marché, erreurs propres.
  const probe = await runPdfcraftScript(
    [{ tool: 'doc_open', args: { path: relIn } }],
    signal,
  );
  const info = probe[0] ?? {};
  if (info.encrypted)
    throw new Error('PDF chiffré : mot de passe requis (non pris en charge).');
  const pageCount = Number(info.pages);
  if (!Number.isFinite(pageCount) || pageCount < 1)
    throw new Error('Impossible de lire ce PDF.');
  // Validation : une seule opération de sortie, sélections dans la plage.
  const fileOps = operations.filter(
    (o) => o.op === 'extract' || o.op === 'to_docx',
  );
  if (fileOps.length > 1)
    throw new Error(
      'Une seule opération de sortie (extract ou to_docx) par appel.',
    );
  if (
    operations.some((o) => o.op === 'compress') &&
    operations.some((o) => o.op === 'extract' || o.op === 'to_docx')
  )
    throw new Error('compress ne se combine ni avec extract ni avec to_docx.');
  const newId = randomUUID();
  const tmpOut = `nevadots-${newId}.pdf`;
  const tmpDocx = `nevadots-${newId}.docx`;
  const steps: PdfcraftStep[] = [{ tool: 'doc_open', args: { path: relIn } }];
  try {
    for (const op of operations) {
      if (op.op === 'rotate')
        steps.push({
          tool: 'page_rotate',
          args: {
            doc: 1,
            degrees: op.degrees ?? 90,
            pages: parseSelection(op.pages, pageCount, 'rotation'),
          },
        });
      else if (op.op === 'delete')
        steps.push({
          tool: 'page_delete',
          args: {
            doc: 1,
            pages: parseSelection(op.pages, pageCount, 'suppression'),
          },
        });
      else if (op.op === 'move') {
        if (op.from > pageCount || op.to > pageCount)
          throw new Error(`Déplacement hors plage (1–${pageCount}).`);
        steps.push({
          tool: 'page_move',
          args: { doc: 1, pages: [op.from], to: op.to },
        });
      } else if (op.op === 'extract')
        steps.push({
          tool: 'page_extract',
          args: {
            doc: 1,
            pages: parseSelection(op.pages, pageCount, 'extraction'),
            out: tmpOut,
            open: false,
          },
        });
      else if (op.op === 'insert_blank') {
        if (op.before > pageCount + 1)
          throw new Error(`Insertion hors plage (1–${pageCount + 1}).`);
        for (let i = 0; i < (op.count ?? 1); i++)
          steps.push({
            tool: 'page_insert_blank',
            args: { doc: 1, at: op.before },
          });
      } else if (op.op === 'metadata') {
        const fields: Array<[string, string | undefined]> = [
          ['Title', op.title],
          ['Author', op.author],
          ['Subject', op.subject],
          ['Keywords', op.keywords],
        ];
        for (const [key, value] of fields)
          if (value !== undefined)
            steps.push({
              tool: 'doc_set_info',
              args: { doc: 1, key, value },
            });
      } else if (op.op === 'compress')
        steps.push({ tool: 'doc_optimize', args: { doc: 1, path: tmpOut } });
      else if (op.op === 'to_docx')
        steps.push({
          tool: 'doc_export_office',
          args: { doc: 1, path: tmpDocx },
        });
      else if (op.op === 'add_text') {
        if (op.page > pageCount)
          throw new Error(`Page ${op.page} inexistante (${pageCount} pages).`);
        steps.push({
          tool: 'page_add_text',
          args: {
            doc: 1,
            page: op.page,
            text: op.text,
            at: [op.x ?? 72, op.y ?? 100],
            size: op.size ?? 12,
          },
        });
      }
    }
    const wantsDocx = operations.some((o) => o.op === 'to_docx');
    const wantsExtract = operations.some((o) => o.op === 'extract');
    const wantsCompress = operations.some((o) => o.op === 'compress');
    const isFileOp = wantsDocx || wantsExtract || wantsCompress;
    if (!isFileOp)
      steps.push({ tool: 'doc_save', args: { doc: 1, path: tmpOut } });
    await runPdfcraftScript(steps, signal);
    // Le résultat reste à la racine du root (comportement vérifié) :
    // on le rapatrie dans le dossier de la nouvelle pièce jointe.
    const produced = wantsDocx ? tmpDocx : tmpOut;
    const producedAbs = join(ATTACHMENTS_DIR, produced);
    if (!existsSync(producedAbs))
      throw new Error('La conversion a échoué (aucun fichier produit).');
    const buffer = await fs.readFile(producedAbs);
    if (!buffer.length) throw new Error('Fichier produit vide.');
    const meta = await readMeta(attachmentId);
    const base = (meta?.name ?? 'document.pdf').replace(/\.[^.]*$/, '');
    const { name, mime } = resultName(base, operations);
    const saved = await saveBinaryAttachment(name, buffer, mime);
    return saved;
  } finally {
    await fs.rm(join(ATTACHMENTS_DIR, tmpOut), { force: true }).catch(() => {});
    await fs
      .rm(join(ATTACHMENTS_DIR, tmpDocx), { force: true })
      .catch(() => {});
  }
}

export interface PdfOcrInput {
  attachmentId: string;
  language?: 'fra' | 'eng' | 'fra+eng';
  mode?: 'skip' | 'force';
}

export async function pdfOcrAttachment(
  input: PdfOcrInput,
  signal?: AbortSignal,
): Promise<AttachmentMeta> {
  const { attachmentId, language = 'fra+eng', mode = 'skip' } = input;
  const absPath = await resolvePdf(attachmentId);
  const size = statSync(absPath).size;
  if (size > MAX_INPUT_BYTES)
    throw new Error('PDF trop volumineux (max 50 Mo).');
  const meta = await readMeta(attachmentId);
  const base = (meta?.name ?? 'document.pdf').replace(/\.[^.]*$/, '');
  const newId = randomUUID();
  const dir = join(ATTACHMENTS_DIR, newId);
  await fs.mkdir(dir, { recursive: true });
  const outAbs = join(process.cwd(), dir, 'file');
  const args = [
    '--language',
    language,
    mode === 'force' ? '--force-ocr' : '--skip-text',
    '--output-type',
    'pdf',
    absPath,
    outAbs,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        OCRMYPDF_PATH(),
        args,
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal },
        (err, _stdout, stderr) => {
          if (err)
            reject(
              new Error(
                stderr?.trim().split('\n').slice(-3).join(' ').slice(0, 300) ||
                  err.message ||
                  'ocrmypdf',
              ),
            );
          else resolve();
        },
      );
    });
  } catch (cause) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
  const buffer = await fs.readFile(outAbs).catch(() => Buffer.alloc(0));
  if (!buffer.length) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error("L'OCR n'a produit aucun fichier.");
  }
  return saveBinaryAttachment(`${base}-ocr.pdf`, buffer, PDF_MIME);
}

function downloadResult(meta: AttachmentMeta) {
  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    downloadUrl: `/api/attachments/${meta.id}/content?download=1`,
  };
}

/** Outils agent : modifier un PDF / ajouter une couche OCR française. */
export function pdfWriteTools(signal?: AbortSignal) {
  const tools = [];
  if (existsSync(pdfcraftCliPath()))
    tools.push(
      defineTool({
        name: 'pdf_edit',
        description:
          'Edit a PDF attachment referenced in the conversation ("[PDF joint … — id: …]"). One call = a list of operations applied in order (rotate/delete/move/extract pages, insert blanks, set metadata, compress, add a text stamp, export to Word). Produces a NEW downloadable file (original untouched); use the returned downloadUrl to present a Markdown download link. Never chain two output operations (extract/to_docx) in one call.',
        parameters: z.object({
          attachmentId: z
            .string()
            .regex(UUID_RE)
            .describe('The attachment id from the [PDF joint …] marker.'),
          operations: z
            .array(editOp)
            .min(1)
            .max(OPS_CAP)
            .describe(
              'Operations applied in order, e.g. [{"op":"rotate","pages":"1-3","degrees":90}].',
            ),
        }),
        execute: async (input: PdfEditInput) =>
          downloadResult(await pdfEditAttachment(input, signal)),
      }),
    );
  if (existsSync(OCRMYPDF_PATH()))
    tools.push(
      defineTool({
        name: 'pdf_ocr',
        description:
          'Add a searchable French text layer to a scanned PDF attachment ("[PDF joint … — id: …]"). Produces a NEW downloadable file (original untouched); use the returned downloadUrl to present a Markdown download link. Use when the user asks to search, copy or quote text from a scan.',
        parameters: z.object({
          attachmentId: z
            .string()
            .regex(UUID_RE)
            .describe('The attachment id from the [PDF joint …] marker.'),
          language: z
            .enum(['fra', 'eng', 'fra+eng'])
            .optional()
            .describe('OCR languages (default fra+eng).'),
          mode: z
            .enum(['skip', 'force'])
            .optional()
            .describe(
              'skip (default): leave pages that already have text; force: redo every page.',
            ),
        }),
        execute: async (input: PdfOcrInput) =>
          downloadResult(await pdfOcrAttachment(input, signal)),
      }),
    );
  return tools;
}
