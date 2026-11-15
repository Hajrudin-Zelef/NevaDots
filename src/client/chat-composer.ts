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

// ---------------------------------------------------------------------------
// Routeur de raccourcis du composer (Lot 5, étape 4).
// `shouldSubmitComposerOnKeyDown` reste la règle d'envoi, inchangée :
// Ctrl+Entrée envoie toujours, Entrée seule = saut de ligne. Le routeur
// ne fait que classer les autres frappes ; ↑/↓ (historique) et Maj+↑
// (liste) sont gérés côté Composer, qui connaît la position du curseur.
// ---------------------------------------------------------------------------

export type ComposerShortcutAction =
  | 'submit'
  | 'queue-front'
  | 'open-attachments'
  | 'toggle-source'
  | 'cycle-dot'
  | 'cycle-dot-reverse'
  | 'toggle-menu'
  | 'cancel';

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

/**
 * Classe une frappe du composer. `null` = frappe ordinaire (texte,
 * navigation, IME) : le textarea la gère nativement. Pendant la
 * composition IME (ou keyCode 229 legacy) rien n'est routé.
 *
 * - Ctrl/⌘+Entrée → `submit` (règle verrouillée, voir ci-dessus)
 * - Alt+Entrée → `queue-front` (tête de file ; `steer` hors périmètre)
 * - Mod+U → `open-attachments` (sélecteur de fichiers)
 * - Mod+' → `toggle-source` (champ page web)
 * - Mod+. → `cycle-dot` (Dot suivant), Maj+Mod+. → `cycle-dot-reverse`
 * - Ctrl+G → `toggle-menu` (menu « + » du composer)
 * - Échap → `cancel` (annule le chargement en file, ferme menu/citation)
 */
export function routeComposerKeyDown(
  event: ComposerKeyEvent,
): ComposerShortcutAction | null {
  if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229)
    return null;
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Enter') {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey) return 'submit';
    if (event.altKey && !event.shiftKey) return 'queue-front';
    return null;
  }
  if (event.key === 'Escape' && !mod && !event.altKey) return 'cancel';
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if (key === 'u' && !event.altKey) return 'open-attachments';
  if (event.key === "'" && !event.altKey) return 'toggle-source';
  if (event.key === '.' && !event.altKey)
    return event.shiftKey ? 'cycle-dot-reverse' : 'cycle-dot';
  if (key === 'g' && event.ctrlKey && !event.metaKey && !event.altKey)
    return 'toggle-menu';
  return null;
}

// ---------------------------------------------------------------------------
// File d'attente en objets (Lot 5, étape 3).
// `queued: string[]` → `Array<QueuedMessage>` ; comportement visible
// inchangé d'abord : l'ordre et la sémantique d'envoi restent les mêmes,
// seul l'identifiant stable permet ✕ / chargement en éditeur par bulle.
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  id: string;
  text: string;
  /** Texte utilisateur retenu pour l'historique (sans citation ni blocs
   *  de pièces jointes injectés par `prepareSend`) — snapshot pris à la
   *  mise en file, car au moment de l'exécution le brouillon a changé. */
  historyPrompt?: string;
  /** Noms des pièces jointes présentes à la mise en file. */
  attachments?: string[];
  /** Citation attachée au message en file (snapshot pris à la mise en
   *  file) : le texte en file porte déjà le bloc `[Citation : …]`, donc
   *  la carte est consommée à la mise en file et ce snapshot dit à
   *  l'exécution quelle carte retirer — jamais une carte posée après. */
  quote?: { text: string; comment: string } | null;
}

/** Snapshot optionnel porté par un message en file (cf. `QueuedMessage`). */
export interface QueuedMessageMeta {
  historyPrompt?: string;
  attachments?: string[];
  quote?: { text: string; comment: string } | null;
}

export function createQueuedMessage(
  text: string,
  meta?: QueuedMessageMeta,
): QueuedMessage {
  return { id: crypto.randomUUID(), text, ...(meta ?? {}) };
}

export function enqueueQueued(
  queue: QueuedMessage[],
  text: string,
  meta?: QueuedMessageMeta,
): QueuedMessage[] {
  return [...queue, createQueuedMessage(text, meta)];
}

export function enqueueQueuedFront(
  queue: QueuedMessage[],
  text: string,
  meta?: QueuedMessageMeta,
): QueuedMessage[] {
  return [createQueuedMessage(text, meta), ...queue];
}

export function dequeueQueued(
  queue: QueuedMessage[],
): { next: QueuedMessage | undefined; rest: QueuedMessage[] } {
  const [next, ...rest] = queue;
  return { next, rest };
}

export function removeQueued(
  queue: QueuedMessage[],
  id: string,
): QueuedMessage[] {
  return queue.filter((item) => item.id !== id);
}
