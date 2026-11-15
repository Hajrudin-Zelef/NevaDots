/**
 * Palier « mobile » de l'interface (même valeur que le tiroir bas et les
 * modales plein écran : 767 px).
 *
 * Sert à une seule décision : sur téléphone, les panneaux (raisonnement,
 * activité, ordinateur) s'ouvrent **à la demande**, jamais tout seuls —
 * en plein écran ils recouvrent la réponse en cours et « gâchent la vue ».
 * Sur tablette/bureau ils restent dockés et peuvent s'ouvrir d'eux-mêmes.
 */
export const MOBILE_VIEWPORT_QUERY = '(max-width: 767px)';

/** Vrai sur téléphone (largeur ≤ 767 px). Sans `window` (rendu serveur,
 *  tests), on répond `false` : comportement bureau, jamais de panneau
 *  ouvert par surprise. */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
}

/** Les panneaux peuvent-ils s'ouvrir d'eux-mêmes ? Jamais sur mobile. */
export function panelsMayAutoOpen(): boolean {
  return !isMobileViewport();
}
