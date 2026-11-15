/**
 * Historique des prompts envoyés (Lot 5, étape 5).
 *
 * Entrée `{ prompt, mode, attachments? }`, persistée en localStorage
 * (une seule liste, la plus récente d'abord). Caps : 200 entrées au total,
 * dont 100 maximum avec pièces jointes. Déduplication exacte
 * (même prompt + même mode + mêmes pièces jointes → une seule entrée,
 * remontée en tête). Une entrée poussée à l'envoi est retirée en cas
 * d'échec du tour (la restauration du brouillon est du côté appelant).
 */

export interface PromptHistoryEntry {
  prompt: string;
  /** Contexte d'envoi : `chat` (conversation en cours) ou `home` (accueil). */
  mode: 'chat' | 'home';
  /** Noms des pièces jointes présentes à l'envoi, le cas échéant. */
  attachments?: string[];
}

export const PROMPT_HISTORY_KEY = 'nevadots:prompt-history';
export const MAX_PROMPT_HISTORY = 200;
export const MAX_PROMPT_HISTORY_WITH_ATTACHMENTS = 100;

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function sameEntry(a: PromptHistoryEntry, b: PromptHistoryEntry): boolean {
  return (
    a.prompt === b.prompt &&
    a.mode === b.mode &&
    (a.attachments?.join('\n') ?? '') === (b.attachments?.join('\n') ?? '')
  );
}

function isValidEntry(value: unknown): value is PromptHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as PromptHistoryEntry;
  return (
    typeof entry.prompt === 'string' &&
    entry.prompt.length > 0 &&
    (entry.mode === 'chat' || entry.mode === 'home') &&
    (entry.attachments === undefined ||
      (Array.isArray(entry.attachments) &&
        entry.attachments.every((name) => typeof name === 'string')))
  );
}

/** Applique la déduplication et les caps à une liste (la plus récente d'abord). */
export function normalizePromptHistory(
  entries: PromptHistoryEntry[],
): PromptHistoryEntry[] {
  const deduped: PromptHistoryEntry[] = [];
  for (const entry of entries) {
    if (!deduped.some((kept) => sameEntry(kept, entry))) deduped.push(entry);
  }
  // Cap « avec pièces jointes » : on garde les 100 plus récentes qui en
  // ont, les plus anciennes sont retirées (les autres restent).
  let withAttachments = 0;
  const capped = deduped.filter((entry) => {
    if (!entry.attachments?.length) return true;
    withAttachments += 1;
    return withAttachments <= MAX_PROMPT_HISTORY_WITH_ATTACHMENTS;
  });
  return capped.slice(0, MAX_PROMPT_HISTORY);
}

export function loadPromptHistory(): PromptHistoryEntry[] {
  if (!storageAvailable()) return [];
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(PROMPT_HISTORY_KEY) ?? '[]',
    );
    if (!Array.isArray(parsed)) return [];
    return normalizePromptHistory(parsed.filter(isValidEntry));
  } catch {
    return [];
  }
}

export function savePromptHistory(entries: PromptHistoryEntry[]): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(
      PROMPT_HISTORY_KEY,
      JSON.stringify(normalizePromptHistory(entries)),
    );
  } catch {
    // Quota dépassé ou stockage indisponible : on continue sans historique.
  }
}

/** Pousse une entrée en tête (dédupliquée, caps appliqués) et persiste. */
export function pushPromptHistory(
  entry: PromptHistoryEntry,
  current: PromptHistoryEntry[] = loadPromptHistory(),
): PromptHistoryEntry[] {
  const next = normalizePromptHistory([
    entry,
    ...current.filter((kept) => !sameEntry(kept, entry)),
  ]);
  savePromptHistory(next);
  return next;
}

/** Retire les entrées identiques à `entry` (échec du tour) et persiste. */
export function removePromptHistoryEntry(
  entry: PromptHistoryEntry,
  current: PromptHistoryEntry[] = loadPromptHistory(),
): PromptHistoryEntry[] {
  const next = current.filter((kept) => !sameEntry(kept, entry));
  savePromptHistory(next);
  return next;
}

/** Curseur sur la première ligne du textarea (↑ = historique). */
export function isCursorOnFirstLine(
  value: string,
  selectionStart: number,
): boolean {
  return !value.slice(0, selectionStart).includes('\n');
}

/** Curseur sur la dernière ligne du textarea (↓ = historique). */
export function isCursorOnLastLine(
  value: string,
  selectionStart: number,
): boolean {
  return !value.slice(selectionStart).includes('\n');
}
