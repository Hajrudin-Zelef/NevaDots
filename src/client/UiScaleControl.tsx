import { Minus, Plus } from 'lucide-react';
import {
  UI_SCALE_MAX_PERCENT,
  UI_SCALE_MIN_PERCENT,
  stepUiScalePercent,
  uiScaleLabel,
} from './ui-scale';
import { useUiScale } from './useUiScale';

/**
 * Deux boutons A− / A+ (barre du haut et Réglages → Apparence).
 *
 * `compact` : variante de la barre du haut (boutons 28 px, libellé 11 px) ;
 * sans `compact` : variante du panneau Réglages (boutons 36 px, libellé
 * 13 px). Les deux bornes désactivent le bouton correspondant, et le
 * libellé est annoncé (`aria-live`) pour les lecteurs d'écran.
 */
export function UiScaleControl({ compact = false }: { compact?: boolean }) {
  const { percent, setPercent } = useUiScale();
  const atMin = percent <= UI_SCALE_MIN_PERCENT;
  const atMax = percent >= UI_SCALE_MAX_PERCENT;
  const iconSize = compact ? 14 : 16;
  return (
    <div
      className={`ui-scale-control${compact ? ' compact' : ''}`}
      role="group"
      aria-label="Taille de l’interface"
    >
      <button
        type="button"
        className="ui-scale-button"
        aria-label="Réduire la taille de l’interface"
        title="Réduire la taille de l’interface"
        disabled={atMin}
        onClick={() => setPercent(stepUiScalePercent(percent, -1))}
      >
        <Minus size={iconSize} aria-hidden="true" />
      </button>
      <span className="ui-scale-value" aria-live="polite">
        {uiScaleLabel(percent)}
      </span>
      <button
        type="button"
        className="ui-scale-button"
        aria-label="Agrandir la taille de l’interface"
        title="Agrandir la taille de l’interface"
        disabled={atMax}
        onClick={() => setPercent(stepUiScalePercent(percent, 1))}
      >
        <Plus size={iconSize} aria-hidden="true" />
      </button>
    </div>
  );
}
