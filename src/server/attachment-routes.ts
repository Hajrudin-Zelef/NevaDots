import { Hono } from 'hono';
import { promises as fs } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const ATTACHMENTS_DIR = 'data/attachments';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 Mo
const PREVIEW_LIMIT = 5 * 1024 * 1024; // 5 Mo (aperçu inline)

export type AttachmentCategory = 'text' | 'code' | 'image' | 'pdf' | 'other';

export interface AttachmentMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  category: AttachmentCategory;
  createdAt: number;
  /** Timestamp du rattachement à un message envoyé (exclut du sweep orphelins). */
  attachedAt?: number;
}

const CODE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'sql',
  'html',
  'css',
  'scss',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'md',
  'vue',
  'svelte',
]);

export function categorizeAttachment(
  mime: string,
  name: string,
): AttachmentCategory {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf'))
    return 'pdf';
  const ext = extname(name).toLowerCase().slice(1);
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

function attachmentDir(id: string): string {
  return join(ATTACHMENTS_DIR, id);
}

async function readMeta(id: string): Promise<AttachmentMeta | null> {
  try {
    const raw = await fs.readFile(join(attachmentDir(id), 'meta.json'), 'utf8');
    return JSON.parse(raw) as AttachmentMeta;
  } catch {
    return null;
  }
}

export function attachmentRoutes() {
  const app = new Hono();

  // Upload multipart : un ou plusieurs fichiers (champ "files").
  app.post('/attachments', async (c) => {
    const body = await c.req.parseBody();
    const raw = body['files'];
    const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
      (item): item is File => item instanceof File,
    );
    if (!files.length) {
      return c.json({ error: 'Aucun fichier reçu.' }, 400);
    }
    await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
    const saved: AttachmentMeta[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return c.json(
          { error: `Fichier trop volumineux (max 50 Mo) : ${file.name}` },
          413,
        );
      }
      // Nom assaini : basename uniquement, sans chemin.
      const name = file.name.split(/[\\/]/).pop() || 'fichier';
      const id = randomUUID();
      const dir = attachmentDir(id);
      await fs.mkdir(dir, { recursive: true });
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(join(dir, 'file'), buffer);
      const meta: AttachmentMeta = {
        id,
        name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        category: categorizeAttachment(file.type || '', name),
        createdAt: Date.now(),
      };
      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
      saved.push(meta);
    }
    return c.json({ attachments: saved }, 201);
  });

  // Contenu du fichier (aperçu inline ou téléchargement).
  // ?download=1 force le téléchargement.
  app.get('/attachments/:id/content', async (c) => {
    const meta = await readMeta(c.req.param('id'));
    if (!meta) return c.json({ error: 'Fichier introuvable.' }, 404);
    const data = await fs.readFile(join(attachmentDir(meta.id), 'file'));
    const download = c.req.query('download') === '1';
    // Neutralise le HTML pour éviter toute exécution de script.
    const mime =
      meta.mime === 'text/html' ? 'text/plain; charset=utf-8' : meta.mime;
    const headers = new Headers({
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(meta.name)}"`,
    });
    // Body binaire : new Response avec Uint8Array.
    return new Response(new Uint8Array(data), { headers });
  });

  // Métadonnées (utile pour vérifier la limite de 5 Mo côté client).
  app.get('/attachments/:id', async (c) => {
    const meta = await readMeta(c.req.param('id'));
    if (!meta) return c.json({ error: 'Fichier introuvable.' }, 404);
    return c.json({ ...meta, previewInline: meta.size <= PREVIEW_LIMIT });
  });

  // Contenu texte (aperçu des fichiers text/code côté serveur).
  app.get('/attachments/:id/text', async (c) => {
    const meta = await readMeta(c.req.param('id'));
    if (!meta) return c.json({ error: 'Fichier introuvable.' }, 404);
    if (meta.category !== 'text' && meta.category !== 'code') {
      return c.json({ error: 'Pas un fichier texte.' }, 400);
    }
    if (meta.size > PREVIEW_LIMIT) {
      return c.json({ error: 'Fichier trop volumineux pour l’aperçu.' }, 413);
    }
    const data = await fs.readFile(
      join(attachmentDir(meta.id), 'file'),
      'utf8',
    );
    return c.json({ content: data });
  });

  // Suppression.
  app.delete('/attachments/:id', async (c) => {
    const id = c.req.param('id');
    const meta = await readMeta(id);
    if (!meta) return c.json({ error: 'Fichier introuvable.' }, 404);
    await fs.rm(attachmentDir(id), { recursive: true, force: true });
    return c.json({ ok: true });
  });

  // Marque des pièces jointes comme rattachées à un message envoyé.
  // Les fichiers rattachés sont exclus du nettoyage des orphelins.
  app.post('/attachments/mark-attached', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      ids?: unknown;
    };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string')
      : [];
    const now = Date.now();
    let marked = 0;
    for (const id of ids) {
      const meta = await readMeta(id);
      if (!meta || meta.attachedAt) continue;
      // Écrit via l'ID relu du meta (pas le paramètre brut).
      await fs.writeFile(
        join(attachmentDir(meta.id), 'meta.json'),
        JSON.stringify({ ...meta, attachedAt: now }),
      );
      marked++;
    }
    return c.json({ marked });
  });

  return app;
}

/**
 * Nettoyage des orphelins (phase 2a) : supprime les pièces jointes jamais
 * rattachées à un message et plus vieilles que `maxAgeMs` (défaut : 7 jours).
 * Appelé au démarrage du serveur. Retourne le nombre de fichiers supprimés.
 */
export async function cleanupOrphanAttachments(
  maxAgeMs = 7 * 24 * 3600 * 1000,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(ATTACHMENTS_DIR);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    const meta = await readMeta(entry);
    if (!meta || meta.attachedAt) continue;
    const createdAt = typeof meta.createdAt === 'number' ? meta.createdAt : now;
    if (now - createdAt > maxAgeMs) {
      await fs
        .rm(attachmentDir(meta.id), { recursive: true, force: true })
        .catch(() => {});
      removed++;
    }
  }
  return removed;
}
