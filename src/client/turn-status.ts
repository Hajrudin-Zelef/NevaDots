import type { AssistantMessage, Message } from '@ag-ui/core';
import { pageReviewTool } from '../shared/page-review';
import { connectionActionTool } from '../shared/connection-types';

/**
 * Ligne de statut sous le tour en cours (portage visuel OpenCode, lot 3).
 * Un seul libellé à la fois — jamais empilé avec un autre signal
 * « ça travaille » (la StepCard reste dépliée pendant le run, c'est le
 * comportement NevaDots conservé ; la ligne porte l'état, pas un spinner).
 *
 * Dérivation depuis `agent.messages` uniquement (aucun nouvel état) :
 * - un appel d'outil HITL sans résultat (`role: 'tool'` manquant pour son
 *   `toolCallId`) bloque le tour en attendant l'utilisateur ;
 * - un `computer_exec` sans résultat bloque le tour sur le shell ;
 * - sinon, pendant un run : le tour travaille.
 *
 * Mapping des deux outils HITL (les deux attendent l'utilisateur, mais
 * pas de la même façon) :
 * - `review_space_page` : l'utilisateur doit approuver un contenu
 *   → « En attente d'approbation ».
 * - `request_connection_action` : l'utilisateur doit répondre à une
 *   action proposée sur un service connecté (approuver / refuser)
 *   → « En attente de votre réponse ».
 * NevaDots n'a pas d'outil « question » : aucun autre signal ne produit
 * « En attente de votre réponse ».
 */

export type TurnStatus = 'working' | 'approval' | 'answer' | 'shell';

export const TURN_STATUS_LABELS: Record<TurnStatus, string> = {
  working: 'Travail en cours',
  approval: 'En attente d’approbation',
  answer: 'En attente de votre réponse',
  shell: 'En attente du shell',
};

/**
 * Statut du tour en cours, ou `null` quand aucun tour ne tourne (la
 * ligne n'est rendue que pendant un run ; à l'arrêt elle disparaît comme
 * le faisait l'ancien indicateur « … is thinking »).
 */
export function deriveTurnStatus(
  messages: Message[],
  running: boolean,
): TurnStatus | null {
  if (!running) return null;
  // Résultats d'outils reçus, par appel (`toolCallId`, même appariement
  // que `deriveActivity` dans `shared/activity.ts`).
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = (message as Message & { toolCallId?: unknown })
        .toolCallId;
      if (typeof toolCallId === 'string') answered.add(toolCallId);
    }
  }
  // Dernier message assistant avec des appels : c'est lui qui bloque le
  // tour s'il attend quelque chose.
  const lastAssistant = [...messages]
    .reverse()
    .find(
      (message): message is AssistantMessage =>
        message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
    );
  if (lastAssistant?.toolCalls) {
    // Priorité : approbation > réponse > shell (un seul libellé affiché).
    let shellPending = false;
    for (const call of lastAssistant.toolCalls) {
      if (answered.has(call.id)) continue;
      if (call.function.name === pageReviewTool.name) return 'approval';
      if (call.function.name === connectionActionTool.name) return 'answer';
      if (call.function.name === 'computer_exec') shellPending = true;
    }
    if (shellPending) return 'shell';
  }
  return 'working';
}
