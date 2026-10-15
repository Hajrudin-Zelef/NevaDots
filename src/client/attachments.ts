export type AttachmentCategory = 'text' | 'code' | 'image' | 'pdf' | 'other';

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
      blocks.push(
        `[Image jointe : ${file.name} (${formatSize(file.size)}) — visible dans l'aperçu de l'interface]`,
      );
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
