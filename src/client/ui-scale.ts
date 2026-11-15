// Échelle de l'interface (deux boutons A− / A+ dans la barre du haut et
// dans Réglages → Apparence).
//
// Principe : `--nd-ui-scale` multiplie TOUT le shell (`zoom` sur
// `.template-app.app`) — texte, espacements, cibles tactiles — comme le
// zoom du navigateur. Les unités de viewport ne suivent pas le zoom : les
// règles `100dvh`/`100vw` du sous-arbre se divisent par l'échelle (voir
// `--nd-dvh` dans responsive.css), sinon le shell laisse une bande vide en
// dessous (échelle < 1) ou déborde (échelle > 1).
//
// La valeur est un pourcentage entier (50–130, pas de 5) : pas d'erreur
// d'arrondi flottant, et `localStorage` reste lisible à la main.
// `public/theme.js` applique la même valeur avant le premier rendu (même
// schéma que le thème) pour éviter un redimensionnement visible.

/** Borne basse : 50 % (beaucoup plus de contenu à l'écran). */
export const UI_SCALE_MIN_PERCENT = 50;
/** Borne haute : 130 % (confort de lecture, cibles tactiles plus grandes). */
export const UI_SCALE_MAX_PERCENT = 130;
/** Pas des deux boutons. */
export const UI_SCALE_STEP_PERCENT = 5;
/** Valeur par défaut : la mise en page nominale. */
export const UI_SCALE_DEFAULT_PERCENT = 100;
/** Clé `localStorage` (lue aussi par `public/theme.js`). */
export const UI_SCALE_STORAGE_KEY = 'nevadots-ui-scale';

/** Ramène un pourcentage quelconque dans la grille 80–130 par pas de 5. */
export function clampUiScalePercent(value: number): number {
  if (!Number.isFinite(value)) return UI_SCALE_DEFAULT_PERCENT;
  const stepped =
    Math.round(value / UI_SCALE_STEP_PERCENT) * UI_SCALE_STEP_PERCENT;
  return Math.min(
    UI_SCALE_MAX_PERCENT,
    Math.max(UI_SCALE_MIN_PERCENT, stepped),
  );
}

/** Relit une valeur stockée, tolérante (absente, vide, `"85 %"`, `"abc"`). */
export function parseUiScalePercent(raw: string | null): number {
  if (raw == null) return UI_SCALE_DEFAULT_PERCENT;
  const parsed = Number(raw.trim().replace(/%$/, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return UI_SCALE_DEFAULT_PERCENT;
  return clampUiScalePercent(parsed);
}

/** Échelle appliquée à cette page (mémoire du module, comme le thème). */
let chosen: number | undefined;

/** Pourcentage courant : choix de cette page, sinon valeur stockée. */
export function uiScalePercent(): number {
  if (chosen !== undefined) return chosen;
  try {
    return parseUiScalePercent(localStorage.getItem(UI_SCALE_STORAGE_KEY));
  } catch {
    return UI_SCALE_DEFAULT_PERCENT;
  }
}

/** Facteur CSS (`0.85`, `1.15`…) — c'est ce qu'écrit `--nd-ui-scale`. */
export function uiScaleFactor(percent: number): number {
  return clampUiScalePercent(percent) / 100;
}

/** Pourcentage suivant dans une direction (+1 = agrandir, −1 = réduire). */
export function stepUiScalePercent(current: number, direction: 1 | -1): number {
  return clampUiScalePercent(
    clampUiScalePercent(current) + direction * UI_SCALE_STEP_PERCENT,
  );
}

/** Libellé affiché par les deux boutons (« 105 % »). */
export function uiScaleLabel(percent: number): string {
  return `${clampUiScalePercent(percent)} %`;
}

/** Écrit l'échelle dans le document (`--nd-ui-scale` + `data-ui-scale`). */
export function applyUiScalePercent(percent: number): void {
  const clamped = clampUiScalePercent(percent);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--nd-ui-scale', String(clamped / 100));
  root.dataset.uiScale = String(clamped);
}

// --- Abonnement (barre du haut et panneau Réglages restent synchronisés) ---

const listeners = new Set<() => void>();

/** Abonne un rendu aux changements d'échelle ; renvoie le désabonnement. */
export function subscribeUiScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Change l'échelle : mémoire de page, stockage, document, abonnés. */
export function setUiScalePercent(percent: number): number {
  const clamped = clampUiScalePercent(percent);
  chosen = clamped;
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(clamped));
  } catch {
    // Stockage refusé (fenêtre privée) : l'échelle vaut pour cette visite.
  }
  applyUiScalePercent(clamped);
  listeners.forEach((listener) => listener());
  return clamped;
}
