/**
 * Auto-scroll du transcript : machine à 4 états (portage visuel OpenCode,
 * lot 3). Remplace le booléen `following` + seuil 48 px + réattachements
 * forcés, qui arrachaient le lecteur de sa lecture à chaque fin de tour et
 * à chaque nouveau message.
 *
 * États :
 * - `following` : le lecteur est en bas ; le contenu qui grandit le fait
 *   suivre (défilement à la frame suivante, pas de saut forcé ailleurs).
 * - `detached` : le lecteur est remonté lire plus haut ; rien ne le
 *   ramène en bas sans son geste explicite (bouton « Revenir en bas » ou
 *   envoi d'un message).
 * - `returning` : reprise demandée ; le retour en bas a lieu à la frame
 *   suivante. L'appelant invalide la tentative (id) si l'utilisateur
 *   remonte entre-temps, pour ne pas le ramener de force.
 * - `anchored` : le lecteur est à moins de ZOOM_SLACK (4 px) de la fin —
 *   un écart de zoom/arrondi, pas une lecture remontée : la vue reste
 *   épinglée à la fin et le contenu qui grandit la rattache à `following`.
 *
 * Règles (valeurs OpenCode, comportements libres) :
 * - `END_EPSILON = 0,5 px` : ce qui compte comme « à la fin ».
 * - `ZOOM_SLACK = 4 px` : tolérance zoom Chrome.
 * - Seul un défilement vers le haut, sur du contenu qui déborde, détache.
 *   Descendre jusqu'à la fin ré-attache ; un défilement programmatique
 *   (vers le bas, jusqu'à la fin) ne détache jamais.
 * - Il n'y a plus aucun réattachement forcé : ni à la fin du run, ni à
 *   l'ajout d'un message — seule la machine décide.
 */

/** Distance qui compte comme « à la fin » (tolérance d'arrondi). */
export const FOLLOW_END_EPSILON_PX = 0.5;
/** Tolérance zoom : en deçà, la vue est épinglée à la fin (`anchored`). */
export const FOLLOW_ZOOM_SLACK_PX = 4;
/** Durée d'un appui maintenu avant de considérer que l'utilisateur lit
 *  (doigt posé sans glisser). Un simple tap ne détache pas. */
export const HOLD_DETACH_MS = 250;
/** Glissement toléré pendant l'appui : au-delà, c'est un défilement (c'est
 *  alors l'événement `scroll` qui décide). */
export const HOLD_MOVE_TOLERANCE_PX = 8;

export type FollowState = 'following' | 'detached' | 'returning' | 'anchored';

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** Distance restante jusqu'en bas (≤ 0 quand le contenu ne déborde pas). */
export function distanceToEnd(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** Le contenu déborde-t-il (y a-t-il quelque chose à remonter lire) ? */
export function hasOverflow(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight > metrics.clientHeight + FOLLOW_END_EPSILON_PX;
}

/** Le lecteur est-il à la fin (à 0,5 px près) ? */
export function isAtEnd(metrics: ScrollMetrics): boolean {
  return distanceToEnd(metrics) <= FOLLOW_END_EPSILON_PX;
}

/** Le lecteur est-il à moins de 4 px de la fin (écart de zoom) ? */
export function isWithinZoomSlack(metrics: ScrollMetrics): boolean {
  return distanceToEnd(metrics) <= FOLLOW_ZOOM_SLACK_PX;
}

export type FollowEvent =
  | {
      type: 'scroll';
      direction: 'up' | 'down';
      /** Distance jusqu'en bas après ce défilement. */
      distance: number;
      overflow: boolean;
    }
  | { type: 'resume' }
  | { type: 'returned' }
  | {
      type: 'content-grew';
      /** Distance jusqu'en bas après la croissance du contenu. */
      distance: number;
    }
  | {
      /** Doigt maintenu sur le transcript sans glisser : l'utilisateur
       *  s'arrête pour lire pendant le streaming. */
      type: 'hold';
      overflow: boolean;
    }
  | {
      /** Un tour démarre : on se replace sur le point de génération, sauf
       *  si l'utilisateur a choisi de lire (détaché pendant CE tour). */
      type: 'turn-started';
      /** L'utilisateur a-t-il remonté pendant le tour précédent ? */
      keepDetached?: boolean;
    };

export function nextFollowState(
  state: FollowState,
  event: FollowEvent,
): FollowState {
  switch (event.type) {
    case 'scroll': {
      // Sans débordement il n'y a rien à remonter : on est en bas.
      if (!event.overflow) return 'following';
      if (event.direction === 'up') {
        // Seul un scroll vers le haut détache — et seulement au-delà de
        // la tolérance zoom : 1 à 4 px d'écart, c'est un arrondi, pas
        // une lecture remontée.
        return event.distance <= FOLLOW_ZOOM_SLACK_PX ? 'anchored' : 'detached';
      }
      // Vers le bas : arriver à la fin ré-attache, s'en approcher
      // épingle ; sinon l'état ne change pas (on ne détache jamais en
      // descendant, on ne force pas non plus le suivi).
      if (event.distance <= FOLLOW_END_EPSILON_PX) return 'following';
      if (event.distance <= FOLLOW_ZOOM_SLACK_PX) return 'anchored';
      return state;
    }
    case 'resume':
      // Reprise explicite (bouton, envoi) : retour à la fin à la frame
      // suivante. Déjà en bas : rien à faire.
      return state === 'following' ? 'following' : 'returning';
    case 'returned':
      // Le défilement programmé a eu lieu : la tentative aboutit.
      // Une tentative périmée (utilisateur remonté entre-temps) est
      // invalidée par l'appelant via son id et n'arrive jamais ici.
      return state === 'returning' ? 'following' : state;
    case 'content-grew': {
      // Le contenu grandit : celui qui suivait suit toujours ; celui
      // qui était épinglé à 4 px près est rattaché ; celui qui lisait
      // plus haut n'est pas touché.
      if (state === 'following') return 'following';
      if (state === 'anchored') return 'following';
      return state;
    }
    case 'hold': {
      // Doigt maintenu sur le transcript : c'est une lecture, pas un
      // arrêt du suivi. On détache pour que le relâchement ne ramène pas
      // la vue en bas. Sans débordement il n'y a rien à lire : l'état ne
      // change pas.
      if (!event.overflow) return state;
      return 'detached';
    }
    case 'turn-started': {
      // Chaque tour repart collé au point de génération : c'est ce qui
      // garantit qu'on voit le texte arriver sans avoir à défiler. Un
      // lecteur détaché qui a explicitement remonté pendant le tour
      // précédent garde sa position (`keepDetached`).
      return event.keepDetached && state === 'detached' ? state : 'following';
    }
  }
}
