import { Hono } from 'hono';
import { promises as fs } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveUploadType } from './magic-bytes.js';
import type { AppVariables } from './request-context.js';
import type { Store } from './store.js';

/** Configurable so attachments can live on a separate volume in production. */
export const ATTACHMENTS_DIR =
  process.env.ATTACHMENTS_DIR?.trim() || 'data/attachments';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 Mo
const PREVIEW_LIMIT = 5 * 1024 * 1024; // 5 Mo (aperçu inline)
const MAX_FILES_PER_UPLOAD = 20;

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
  /** Timestamp de consommation par un run modèle (images multimodales). */
  consumedAt?: number;
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

/** Id de pièce jointe = UUID strict ; tout le reste est rejeté (anti-traversal `:id`). */
const ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function attachmentDir(id: string): string {
  return join(ATTACHMENTS_DIR, id);
}

/**
 * Phase E (suppression de compte) : supprime les fichiers d'une liste de
 * pièces jointes. Les ids non-UUID sont ignorés (anti-traversal).
 */
export async function deleteAttachmentFiles(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!ATTACHMENT_ID_RE.test(id)) continue;
    await fs.rm(attachmentDir(id), { recursive: true, force: true });
  }
}

export async function readMeta(id: string): Promise<AttachmentMeta | null> {
  if (!ATTACHMENT_ID_RE.test(id)) return null;
  try {
    const raw = await fs.readFile(join(attachmentDir(id), 'meta.json'), 'utf8');
    return JSON.parse(raw) as AttachmentMeta;
  } catch {
    return null;
  }
}

export function attachmentRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();
  // C2 : chaque pièce jointe appartient au compte qui l'a envoyée
  // (table `attachment_users` du Store). Une pièce jointe d'un autre
  // compte se comporte comme si elle n'existait pas (404).
  const owned = (store: Store, id: string) =>
    store.attachmentOwner(id) !== undefined;

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
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return c.json(
        {
          error: `Trop de fichiers (max ${MAX_FILES_PER_UPLOAD} par envoi).`,
        },
        413,
      );
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
      // Magic bytes : ne jamais croire le type déclaré par le navigateur
      // (cf. magic-bytes.ts). En cas de mismatch, le fichier est dégradé
      // en octet-stream / 'other' : l'extension (.pdf) ne doit pas non
      // plus re-monter la catégorie vers 'pdf'.
      const declared = file.type || 'application/octet-stream';
      const { mime, ok } = resolveUploadType(buffer, declared, name);
      const category: AttachmentCategory = ok
        ? categorizeAttachment(mime, name)
        : 'other';
      await fs.writeFile(join(dir, 'file'), buffer);
      const meta: AttachmentMeta = {
        id,
        name,
        size: file.size,
        mime,
        category,
        createdAt: Date.now(),
      };
      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
      // C2 : l'upload enregistre le propriétaire (jamais volé ensuite :
      // claimAttachment ne touche pas une pièce déjà attribuée).
      c.get('store').claimAttachment(id, c.get('userId'));
      saved.push(meta);
    }
    return c.json({ attachments: saved }, 201);
  });

  // Contenu du fichier (aperçu inline ou téléchargement).
  // ?download=1 force le téléchargement.
  app.get('/attachments/:id/content', async (c) => {
    const meta = await readMeta(c.req.param('id'));
    if (!meta || !owned(c.get('store'), meta.id))
      return c.json({ error: 'Fichier introuvable.' }, 404);
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
    if (!meta || !owned(c.get('store'), meta.id))
      return c.json({ error: 'Fichier introuvable.' }, 404);
    return c.json({ ...meta, previewInline: meta.size <= PREVIEW_LIMIT });
  });

  // Contenu texte (aperçu des fichiers text/code côté serveur).
  app.get('/attachments/:id/text', async (c) => {
    const meta = await readMeta(c.req.param('id'));
    if (!meta || !owned(c.get('store'), meta.id))
      return c.json({ error: 'Fichier introuvable.' }, 404);
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
    const meta = await readMeta(c.req.param('id'));
    if (!meta || !owned(c.get('store'), meta.id))
      return c.json({ error: 'Fichier introuvable.' }, 404);
    await fs.rm(attachmentDir(meta.id), { recursive: true, force: true });
    c.get('store').deleteAttachmentOwner(meta.id);
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
      // C2 : on ne marque que ses propres pièces jointes.
      if (!meta || meta.attachedAt || !owned(c.get('store'), meta.id)) continue;
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

/**
 * C2 — réclame les pièces jointes orphelines (sans propriétaire) au
 * premier compte (boot / bootstrap). Les pièces déjà attribuées ne sont
 * jamais touchées (garde NOT EXISTS dans claimAttachment).
 */
export async function claimOrphanAttachments(
  store: Store,
  userId: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(ATTACHMENTS_DIR);
  } catch {
    return 0;
  }
  let claimed = 0;
  for (const entry of entries) {
    const meta = await readMeta(entry);
    if (!meta) continue;
    // Contrôle système : seule une pièce VRAIMENT sans propriétaire
    // est réclamée (celle d'un autre compte ne l'est jamais).
    if (store.attachmentOwnerAny(meta.id) === undefined) {
      store.claimAttachment(meta.id, userId);
      claimed++;
    }
  }
  return claimed;
}
const IMAGE_MODEL_LIMIT = 5 * 1024 * 1024;
/** Fenêtre de rattachement : l'image doit avoir été jointe récemment. */
const IMAGE_CLAIM_WINDOW_MS = 10 * 60 * 1000;

export interface ClaimedImage {
  id: string;
  mime: string;
  base64: string;
}

/**
 * Phase 5 (multimodal) : récupère les images rattachées à un message mais
 * pas encore consommées par un run modèle, et les marque comme consommées.
 * Les images > 5 Mo sont marquées consommées mais ignorées (trop lourdes
 * pour l'input modèle).
 */
/**
 * Phase 5 (multimodal) : récupère les images rattachées à un message mais
 * pas encore consommées par un run modèle, et les marque comme consommées.
 * C2 : seules les images DU COMPTE porté par `store` sont réclamées
 * (un Dot ne consomme jamais l'image d'un autre compte).
 */
export async function claimUnconsumedImages(
  store: Store,
): Promise<ClaimedImage[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(ATTACHMENTS_DIR);
  } catch {
    return [];
  }
  const now = Date.now();
  const claimed: ClaimedImage[] = [];
  for (const entry of entries) {
    const meta = await readMeta(entry);
    if (
      !meta ||
      meta.category !== 'image' ||
      !meta.attachedAt ||
      meta.consumedAt ||
      store.attachmentOwner(meta.id) === undefined
    )
      continue;
    if (now - meta.attachedAt > IMAGE_CLAIM_WINDOW_MS) continue;
    // Marque consommé dans tous les cas (même si trop lourde : pas de retry).
    await fs
      .writeFile(
        join(attachmentDir(meta.id), 'meta.json'),
        JSON.stringify({ ...meta, consumedAt: now }),
      )
      .catch(() => {});
    if (meta.size > IMAGE_MODEL_LIMIT) continue;
    try {
      const data = await fs.readFile(join(attachmentDir(meta.id), 'file'));
      claimed.push({
        id: meta.id,
        mime: meta.mime,
        base64: data.toString('base64'),
      });
    } catch {
      // Fichier illisible : ignoré.
    }
  }
  return claimed;
}
