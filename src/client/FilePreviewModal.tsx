import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { ThinkingOrb } from './ThinkingOrb';
import type { Attachment } from './attachments';
import {
  PREVIEW_LIMIT,
  attachmentContentUrl,
  attachmentDownloadUrl,
  formatSize,
} from './attachments';
import { api } from './api';

/**
 * Modale d'aperçu d'un fichier joint.
 * - ≤ 5 Mo : aperçu inline (image, texte/code, PDF via lecteur natif).
 * - > 5 Mo : proposition de téléchargement.
 */
export function FilePreviewModal({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(
    attachment.textContent ?? null,
  );
  const [textError, setTextError] = useState('');

  const tooLarge = attachment.size > PREVIEW_LIMIT;
  const isLocal = attachment.id.startsWith('local-');

  useEffect(() => {
    if (
      text !== null ||
      tooLarge ||
      (attachment.category !== 'text' && attachment.category !== 'code')
    )
      return;
    // Contenu texte déjà lu côté client, sinon via le serveur.
    if (isLocal) return;
    let active = true;
    setTextError('');
    void api<{ content?: string }>(
      '/attachments/' + attachment.id + '/text',
      'GET',
    )
      .then((result) => {
        if (active) setText(result.content ?? '');
      })
      .catch(() => {
        if (active) setTextError('Aperçu indisponible.');
      });
    return () => {
      active = false;
    };
  }, [attachment, text, tooLarge, isLocal]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const contentUrl = isLocal
    ? (attachment.objectUrl ?? '')
    : attachmentContentUrl(attachment.id);

  return (
    <div
      className="file-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Aperçu — ${attachment.name}`}
      onClick={onClose}
    >
      <div
        className="file-preview-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="file-preview-head">
          <div>
            <strong>{attachment.name}</strong>
            <span>
              {formatSize(attachment.size)} · {attachment.mime}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Fermer l'aperçu"
          >
            <X size={16} />
          </button>
        </header>
        <div className="file-preview-body">
          {tooLarge ? (
            <div className="file-preview-too-large">
              <p>
                Ce fichier dépasse 5 Mo — l'aperçu inline n'est pas proposé.
              </p>
              {!isLocal && (
                <a
                  className="primary-button"
                  href={attachmentDownloadUrl(attachment.id)}
                  download={attachment.name}
                >
                  <Download size={15} /> Télécharger (
                  {formatSize(attachment.size)})
                </a>
              )}
            </div>
          ) : attachment.category === 'image' && contentUrl ? (
            <img
              src={contentUrl}
              alt={attachment.name}
              className="file-preview-image"
            />
          ) : attachment.category === 'pdf' && !isLocal ? (
            <iframe
              src={contentUrl}
              title={attachment.name}
              className="file-preview-pdf"
              // Défense en profondeur : le PDF affiché ne peut rien faire
              // (pas de scripts, pas de popups) — la protection actuelle
              // repose déjà sur text/plain + CSP côté serveur.
              sandbox=""
            />
          ) : attachment.category === 'text' ||
            attachment.category === 'code' ? (
            textError ? (
              <p className="file-preview-error">{textError}</p>
            ) : text === null ? (
              <p className="file-preview-loading">
                <ThinkingOrb kind="loading" /> Chargement…
              </p>
            ) : (
              <pre className="file-preview-text">{text}</pre>
            )
          ) : (
            <div className="file-preview-too-large">
              <p>Aperçu non disponible pour ce type de fichier.</p>
              {!isLocal && (
                <a
                  className="primary-button"
                  href={attachmentDownloadUrl(attachment.id)}
                  download={attachment.name}
                >
                  <Download size={15} /> Télécharger (
                  {formatSize(attachment.size)})
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
