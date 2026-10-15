export type AttachmentCategory = 'text' | 'code' | 'image' | 'pdf' | 'other';

/** État d'upload d'une pièce jointe (phase 2a : upload immédiat à la sélection). */
export type AttachmentUploadStatus = 'uploading' | 'ready' | 'error';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  category: AttachmentCategory;
  /** Contenu texte déjà lu côté client (text/code), pour injection au modèle. */
  textContent?: string;
  /** URL objet locale pour la miniature (images), révoquée au retrait. */
  objectUrl?: string;
  /** État de l'upload serveur. */
  status: AttachmentUploadStatus;
}

/** Limite d'aperçu inline : 5 Mo (au-delà → téléchargement proposé). */
export const PREVIEW_LIMIT = 5 * 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function attachmentContentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}/content`;
}

export function attachmentDownloadUrl(id: string): string {
  return `${attachmentContentUrl(id)}?download=1`;
}

/**
 * Construit le texte du message avec les pièces jointes.
 * - text/code : contenu injecté en bloc (lecture native par le modèle).
 * - image/pdf/autre : référence (le pipeline actuel est texte uniquement).
 */
export function buildMessageWithAttachments(
  text: string,
  files: Attachment[],
): string {
  if (!files.length) return text;
  const blocks: string[] = [];
  for (const file of files) {
    if (
      (file.category === 'text' || file.category === 'code') &&
      file.textContent
    ) {
      const content =
        file.textContent.length > 50000
          ? `${file.textContent.slice(0, 50000)}\n…[tronqué à 50 000 caractères]`
          : file.textContent;
      blocks.push(`[Fichier : ${file.name}]\n\`\`\`\n${content}\n\`\`\``);
    } else if (file.category === 'image') {
      blocks.push(`[Image jointe : ${file.name} (${formatSize(file.size)})]`);
    } else if (file.category === 'pdf') {
      blocks.push(
        `[PDF joint : ${file.name} (${formatSize(file.size)}) — aperçu disponible dans l'interface]`,
      );
    } else {
      blocks.push(`[Fichier joint : ${file.name} (${formatSize(file.size)})]`);
    }
  }
  return text ? `${text}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Persistance localStorage des pièces jointes en attente (phase 2a)   */
/* ------------------------------------------------------------------ */

/**
 * Seuls les fichiers déjà uploadés (ID serveur) sont persistés : le File
 * d'origine n'est pas sérialisable et l'upload est déjà fait.
 */
interface StoredAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  category: AttachmentCategory;
  textContent?: string;
}

/** textContent persisté uniquement sous ce seuil (quota localStorage ~5 Mo). */
export const PENDING_TEXT_CACHE_LIMIT = 1_000_000;

function pendingKey(scope: string): string {
  return `nevadots:attachments:${scope}`;
}

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

/** Relit les pièces jointes en attente pour un contexte (brouillon). */
export function loadPendingAttachments(scope: string): StoredAttachment[] {
  if (!storageAvailable()) return [];
  try {
    const raw = localStorage.getItem(pendingKey(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredAttachment =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as StoredAttachment).id === 'string' &&
        !(entry as StoredAttachment).id.startsWith('local-'),
    );
  } catch {
    return [];
  }
}

/** Persiste les pièces jointes prêtes (ID serveur) d'un brouillon. */
export function savePendingAttachments(
  scope: string,
  items: Attachment[],
): void {
  if (!storageAvailable()) return;
  try {
    const stored: StoredAttachment[] = items
      .filter((a) => a.status === 'ready' && !a.id.startsWith('local-'))
      .map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        mime: a.mime,
        category: a.category,
        ...(a.textContent && a.textContent.length <= PENDING_TEXT_CACHE_LIMIT
          ? { textContent: a.textContent }
          : {}),
      }));
    localStorage.setItem(pendingKey(scope), JSON.stringify(stored));
  } catch {
    // Quota dépassé ou stockage indisponible : on continue sans persistance.
  }
}

/** Vide le brouillon persisté (après envoi). */
export function clearPendingAttachments(scope: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.removeItem(pendingKey(scope));
  } catch {
    // Ignoré : le brouillon sera simplement re-proposé à la prochaine visite.
  }
}
