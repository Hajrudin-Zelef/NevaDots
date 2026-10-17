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
      // En-tête porteur de longueur : le parseur d'affichage sait où finit
      // le bloc sans parser le contenu (qui peut contenir des fences).
      blocks.push(
        `[Fichier : ${file.name} — ${content.length} car.]\n\`\`\`fichier\n${content}\n\`\`\``,
      );
    } else if (file.category === 'image') {
      blocks.push(`[Image jointe : ${file.name} (${formatSize(file.size)})]`);
    } else if (file.category === 'pdf') {
      blocks.push(
        `[PDF joint : ${file.name} (${formatSize(file.size)}) — id: ${file.id} — lis-le avec l'outil read_pdf]`,
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

/** Puce d'affichage pour un bloc de contenu injecté. */
export interface AttachmentChip {
  name: string;
  /** Longueur exacte du bloc injecté (lue dans l'en-tête). */
  chars: number;
  body: string;
  truncated: boolean;
}

export interface ParsedUserMessage {
  /** Brouillon sans les blocs de contenu. */
  text: string;
  attachments: AttachmentChip[];
}

const INJECTED_RE = /\[Fichier : (.+?) — (\d+) car\.\]\n```fichier\n/gs;
const CLOSING_FENCE = '\n```';
const TRUNCATED_MARK = '…[tronqué';
// Historique : format sans longueur, repli approximatif (non déterministe).
const LEGACY_RE = /\[Fichier : (.+?)\]\n```\n/gs;

/** Compteur de caractères FR pour la puce (12 345 car., 12,5k car.). */
export function formatChars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')}k car.`;
  return `${n} car.`;
}

/**
 * Découpe un message utilisateur en brouillon + puces de pièces jointes.
 * Le nouveau format est déterministe (la longueur N de l'en-tête fixe la
 * fin exacte du bloc, quoi que contienne le texte). Sans bloc : le texte
 * est renvoyé tel quel. Jamais de throw, jamais de perte de contenu.
 */
export function parseUserMessageWithAttachments(
  content: string,
): ParsedUserMessage {
  const attachments: AttachmentChip[] = [];
  let text = '';
  let rest = content;
  for (;;) {
    const fresh = [...rest.matchAll(INJECTED_RE)][0];
    const legacy = [...rest.matchAll(LEGACY_RE)][0];
    const pick =
      fresh && (!legacy || fresh.index <= legacy.index) ? 'new' : 'legacy';
    const m = pick === 'new' ? fresh : legacy;
    if (!m) {
      text += rest;
      break;
    }
    text += rest.slice(0, m.index);
    if (pick === 'new') {
      const chars = Number(m[2]);
      const bodyStart = m.index + m[0].length;
      const body = rest.slice(bodyStart, bodyStart + chars);
      const after = rest.slice(bodyStart + chars);
      if (!after.startsWith(CLOSING_FENCE)) {
        // En-tête sans suite valide : texte brut, pas de repli aventureux.
        text += rest.slice(0, bodyStart);
        rest = rest.slice(bodyStart);
        continue;
      }
      attachments.push({
        name: m[1],
        chars,
        body,
        truncated: body.includes(TRUNCATED_MARK),
      });
      rest = after.slice(CLOSING_FENCE.length);
    } else {
      const bodyStart = m.index + m[0].length;
      const close = rest.indexOf(CLOSING_FENCE, bodyStart);
      if (close < 0) {
        // Pas de fermeture : approximation sur tout le reste.
        attachments.push({
          name: m[1],
          chars: rest.length - bodyStart,
          body: rest.slice(bodyStart),
          truncated: rest.slice(bodyStart).includes(TRUNCATED_MARK),
        });
        break;
      }
      attachments.push({
        name: m[1],
        chars: close - bodyStart,
        body: rest.slice(bodyStart, close),
        truncated: rest.slice(bodyStart, close).includes(TRUNCATED_MARK),
      });
      rest = rest.slice(close + CLOSING_FENCE.length);
    }
  }
  return { text: text.trim(), attachments };
}
