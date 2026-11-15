import type { Conversation } from '../shared/types';

/**
 * Tri + groupes de la liste des sessions (Lot 2 du portage visuel OpenCode).
 *
 * - Tri : `updatedAt ?? createdAt` décroissant — reprendre une vieille
 *   conversation (qui met à jour `updatedAt` via `recordThreadActivity`)
 *   la fait remonter en tête, dans « Aujourd'hui ».
 * - Groupes : Aujourd'hui / Hier / Plus anciennes (les 3 seuls libellés
 *   du brief ; pas de « 7 derniers jours » ni de mois).
 * - La conversation maître (« Discussion principale ») est exclue ici :
 *   l'appelant l'épingle au-dessus des groupes.
 */

export type SessionGroupLabel = "Aujourd'hui" | 'Hier' | 'Plus anciennes';

export const SESSION_GROUP_LABELS: readonly SessionGroupLabel[] = [
  "Aujourd'hui",
  'Hier',
  'Plus anciennes',
];

/** Clé de tri : dernière activité, sinon création. */
export function sessionSortKey(conversation: Conversation): number {
  return conversation.updatedAt ?? conversation.createdAt;
}

/** Tri décroissant par dernière activité (stable : l'ordre d'entrée départage). */
export function sortSessions(
  conversations: readonly Conversation[],
): Conversation[] {
  return [...conversations].sort(
    (a, b) => sessionSortKey(b) - sessionSortKey(a),
  );
}

function startOfDay(ts: number): number {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function sessionGroupLabel(
  ts: number,
  now = Date.now(),
): SessionGroupLabel {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (diff <= 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return 'Plus anciennes';
}

/**
 * Groupe une liste DÉJÀ TRIÉE (ordre décroissant conservé dans chaque
 * groupe) en buckets consécutifs, dans l'ordre Aujourd'hui → Hier →
 * Plus anciennes. Les groupes vides sont omis.
 */
export function groupSessions(
  conversations: readonly Conversation[],
  now = Date.now(),
): { label: SessionGroupLabel; items: Conversation[] }[] {
  const groups: { label: SessionGroupLabel; items: Conversation[] }[] = [];
  for (const conversation of conversations) {
    const label = sessionGroupLabel(sessionSortKey(conversation), now);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(conversation);
    else groups.push({ label, items: [conversation] });
  }
  return groups;
}

/** Nombre maximal de lignes affichées dans la liste (maître incluse). */
export const MAX_DISPLAYED_SESSIONS = 64;
