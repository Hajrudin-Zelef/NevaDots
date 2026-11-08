/**
 * Envoi explicite au clavier : Ctrl+Entrée (ou ⌘+Entrée sur Mac).
 * Entrée seule insère un saut de ligne (jamais d'envoi accidentel) ;
 * Maj+Entrée aussi (comportement natif du textarea, non intercepté).
 */
export function shouldSubmitComposerOnKeyDown(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  nativeEvent: {
    isComposing?: boolean;
    keyCode?: number;
  };
}) {
  return (
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

export function submitComposerOnEnter(
  event: Parameters<typeof shouldSubmitComposerOnKeyDown>[0] & {
    preventDefault(): void;
    currentTarget: { form?: { requestSubmit(): void } | null };
  },
  canSubmit: boolean,
) {
  if (!shouldSubmitComposerOnKeyDown(event)) return;
  event.preventDefault();
  if (canSubmit) event.currentTarget.form?.requestSubmit();
}
