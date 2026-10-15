import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { FileCard } from './FileCard';
import { FilePreviewModal } from './FilePreviewModal';
import type { Attachment } from './attachments';
import type { useAttachments } from './useAttachments';

export interface AttachmentBarHandle {
  openFilesPicker: () => void;
  openFolderPicker: () => void;
}

/**
 * Barre de pièces jointes du composer : inputs cachés (fichiers + dossier),
 * cartes de fichiers, modale d'aperçu.
 */
export const AttachmentBar = forwardRef<
  AttachmentBarHandle,
  { attachments: ReturnType<typeof useAttachments> }
>(function AttachmentBar({ attachments }, ref) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);

  useImperativeHandle(ref, () => ({
    openFilesPicker: () => filesInput.current?.click(),
    openFolderPicker: () => folderInput.current?.click(),
  }));

  return (
    <>
      <input
        ref={filesInput}
        type="file"
        multiple
        className="file-input-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files?.length) {
            attachments.addFiles(event.target.files);
          }
          event.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        // @ts-expect-error — webkitdirectory n'est pas dans les types React.
        webkitdirectory=""
        className="file-input-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files?.length) {
            attachments.addFiles(event.target.files);
          }
          event.target.value = '';
        }}
      />
      {attachments.items.length > 0 && (
        <div className="file-cards" role="list" aria-label="Fichiers joints">
          {attachments.items.map((item) => (
            <FileCard
              key={item.id}
              attachment={item}
              onRemove={attachments.remove}
              onPreview={setPreview}
            />
          ))}
        </div>
      )}
      {preview && (
        <FilePreviewModal
          attachment={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
});
