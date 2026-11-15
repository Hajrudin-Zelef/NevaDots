/**
 * Largeur de la sidebar (Lot 2 du portage visuel OpenCode).
 *
 * La largeur est persistée en `localStorage` (clé ci-dessous) et lue au
 * chargement. Sur un profil frais la clé est absente : `getItem` retourne
 * `null`, et `Number(null)` vaut `0` — d'où l'importance de tester la
 * chaîne brute d'abord. Une valeur absente, vide, non numérique ou
 * <= 0 retourne le défaut 240 px ; une valeur valide est bornée à
 * 136–640 px.
 */

export const SIDEBAR_WIDTH_KEY = 'nevadots-sidebar-w';
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 136;
export const SIDEBAR_WIDTH_MAX = 640;

/** Parse la valeur brute stockée ; défaut 240 px si absente ou invalide. */
export function parseSidebarWidth(raw: string | null): number {
  if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value));
}

/** Lit la largeur persistée (240 px par défaut sur un profil frais). */
export function readSidebarWidth(): number {
  return parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
}
