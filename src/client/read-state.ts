import type { Conversation } from '../shared/types';

/**
 * État lu / non-lu des sessions (Lot 2 du portage visuel OpenCode).
 *
 * Il n'existe côté serveur aucun signal « non-lu » : l'état est local
 * (`localStorage`, clé ci-dessous) et se définit ainsi — une conversation
 * est non-lue quand sa dernière activité (`updatedAt ?? createdAt`) est
 * postérieure à sa dernière ouverture par l'utilisateur. Ouvrir une
 * conversation la marque lue ; « Marquer lu » (menu contextuel) fait de
 * même sans l'ouvrir. Le point non-lu 7 px du bouton flottant de la
 * sidebar s'allume dès qu'une conversation est non-lue.
 */

export const READ_SEEN_KEY = 'nevadots-read-seen';

/** threadId → horodatage (ms) de la dernière ouverture. */
export type SeenMap = Record<string, number>;

export function loadSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(READ_SEEN_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const seen: SeenMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        seen[key] = value;
    }
    return seen;
  } catch {
    return {};
  }
}

export function saveSeen(seen: SeenMap): void {
  try {
    localStorage.setItem(READ_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Appliqué pour cette visite seulement.
  }
}

function lastActivity(conversation: Conversation): number {
  return conversation.updatedAt ?? conversation.createdAt;
}

export function isUnread(conversation: Conversation, seen: SeenMap): boolean {
  return lastActivity(conversation) > (seen[conversation.id] ?? 0);
}

export function hasUnread(
  conversations: readonly Conversation[],
  seen: SeenMap,
): boolean {
  return conversations.some((conversation) => isUnread(conversation, seen));
}

/** Marque une conversation lue (nouvel objet, l'entrée d'origine intacte). */
export function markSeen(
  seen: SeenMap,
  threadId: string,
  now = Date.now(),
): SeenMap {
  if (!threadId) return seen;
  return { ...seen, [threadId]: now };
}
