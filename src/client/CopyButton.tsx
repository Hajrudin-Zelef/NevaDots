import { useState } from 'react';

/** Petit bouton « Copier / Copié ! » (StepCard, ComputerToolCard). */
export function CopyButton({
  text,
  label = 'Copier',
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        if (typeof navigator === 'undefined' || !navigator.clipboard) return;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            /* copie best-effort */
          });
      }}
    >
      {copied ? 'Copié !' : label}
    </button>
  );
}
