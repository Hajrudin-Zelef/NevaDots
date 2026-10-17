import {
  Code2,
  FileImage,
  FileText,
  FileType,
  File as FileIcon,
  RotateCcw,
  X,
} from 'lucide-react';
import type { Attachment } from './attachments';
import { attachmentContentUrl, formatSize } from './attachments';
import { ThinkingOrb } from './ThinkingOrb';

const CATEGORY_ICON = {
  text: FileText,
  code: Code2,
  image: FileImage,
  pdf: FileType,
  other: FileIcon,
} as const;

export function FileCard({
  attachment,
  onRemove,
  onPreview,
  onRetry,
}: {
  attachment: Attachment;
  onRemove: (id: string) => void;
  onPreview: (attachment: Attachment) => void;
  onRetry: (id: string) => void;
}) {
  const Icon = CATEGORY_ICON[attachment.category];
  const isImage = attachment.category === 'image';
  // Miniature : URL objet locale si dispo, sinon contenu serveur.
  const thumb =
    attachment.objectUrl ??
    (isImage && !attachment.id.startsWith('local-')
      ? attachmentContentUrl(attachment.id)
      : undefined);
  const isUploading = attachment.status === 'uploading';
  const isError = attachment.status === 'error';

  return (
    <div className="file-card" role="listitem">
      <button
        type="button"
        className="file-card-main"
        onClick={() => onPreview(attachment)}
        title={`Aperçu — ${attachment.name}`}
        aria-label={`Aperçu du fichier ${attachment.name}`}
      >
        {thumb ? (
          <img src={thumb} alt="" className="file-card-thumb" loading="lazy" />
        ) : (
          <span className={`file-card-icon ${attachment.category}`}>
            <Icon size={20} />
          </span>
        )}
        <span className="file-card-meta">
          <span className="file-card-name">{attachment.name}</span>
          <span className="file-card-size">
            {isUploading ? (
              <span className="file-card-status">
                <ThinkingOrb kind="working" label="Envoi en cours" /> Envoi…
              </span>
            ) : isError ? (
              <span className="file-card-status error">Échec de l'envoi</span>
            ) : (
              formatSize(attachment.size)
            )}
          </span>
        </span>
      </button>
      {isError && (
        <button
          type="button"
          className="file-card-retry"
          onClick={() => onRetry(attachment.id)}
          aria-label={`Réessayer l'envoi de ${attachment.name}`}
          title="Réessayer l'envoi"
        >
          <RotateCcw size={14} />
        </button>
      )}
      <button
        type="button"
        className="file-card-remove"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Retirer ${attachment.name}`}
        title="Retirer"
      >
        <X size={14} />
      </button>
    </div>
  );
}
