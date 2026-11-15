/**
 * Repli du message utilisateur (portage visuel OpenCode, lot 3) :
 * passé 12 lignes, on n'en montre que 8 + « Voir plus / Voir moins ».
 * La mesure est faite sur le rendu (hauteur réelle / hauteur de ligne),
 * pas sur le nombre de lignes sources — le Markdown rend des lignes
 * plus ou moins longues que le texte brut.
 *
 * Le repli s'applique au texte de la bulle uniquement, pas aux puces de
 * pièces jointes (qui ont déjà leur propre repli `<details>`).
 */

/** Au-delà de ce nombre de lignes rendues, le message se replie. */
export const USER_MESSAGE_FOLD_OVER_LINES = 12;
/** Nombre de lignes montrées quand le message est replié. */
export const USER_MESSAGE_FOLD_SHOW_LINES = 8;

/**
 * Hauteur de ligne en px depuis la valeur calculée (`21px`, `150 %`) et
 * la taille de police. `null` pour `normal` ou une unité inconnue : pas
 * de mesure fiable, donc pas de repli (on ne devine pas).
 */
export function parseLineHeightPx(
  lineHeight: string,
  fontSizePx: number,
): number | null {
  const value = lineHeight.trim();
  if (value.endsWith('px')) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (value.endsWith('%')) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return null;
    return (fontSizePx * parsed) / 100;
  }
  return null;
}

/** Le texte rendu dépasse-t-il 12 lignes (à un demi-pixel près) ? */
export function isUserTextFoldable(
  scrollHeight: number,
  lineHeightPx: number,
): boolean {
  if (
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(lineHeightPx) ||
    lineHeightPx <= 0
  )
    return false;
  return scrollHeight > USER_MESSAGE_FOLD_OVER_LINES * lineHeightPx + 0.5;
}

/** Hauteur maximale du texte replié : 8 lignes. */
export function userTextFoldMaxHeightPx(lineHeightPx: number): number {
  return USER_MESSAGE_FOLD_SHOW_LINES * lineHeightPx;
}
