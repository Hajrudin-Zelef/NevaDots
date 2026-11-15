import { useSyncExternalStore } from 'react';
import {
  applyUiScalePercent,
  setUiScalePercent,
  subscribeUiScale,
  uiScalePercent,
} from './ui-scale';

/**
 * Échelle de l'interface courante, partagée par la barre du haut et le
 * panneau Réglages. `useSyncExternalStore` : les deux rendus restent
 * synchronisés sans contexte React ni re-rendu global.
 */
export function useUiScale(): {
  percent: number;
  setPercent: (percent: number) => void;
} {
  const percent = useSyncExternalStore(
    subscribeUiScale,
    uiScalePercent,
    uiScalePercent,
  );
  return { percent, setPercent: setUiScalePercent };
}

/** Applique l'échelle stockée au démarrage (avant le premier rendu React ;
 *  `public/theme.js` l'a déjà posée avant la première peinture). */
export function initUiScale(): void {
  applyUiScalePercent(uiScalePercent());
}
