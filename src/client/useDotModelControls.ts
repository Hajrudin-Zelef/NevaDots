import { useEffect, useState } from 'react';
import { api } from './api';
import { modelKey, type ModelsResponse } from '../shared/models';

/**
 * Contrôles modèle + raisonnement partagés entre l'accueil (App) et la
 * session (Chat). Centralise ce qui était dupliqué des deux côtés :
 * fetch `/models` (avec écoute `models-changed`), libellés dérivés FR et
 * `cycleReasoning` (PUT `/dots/:id/reasoning`).
 */
export interface DotModelControls {
  /** Catalogue complet des modèles et providers. */
  models: ModelsResponse;
  /** Clé de sélection pour le `<select>` (`provider::model`, '' = défaut). */
  modelValue: string;
  /** Libellé du modèle par défaut (ou repli fourni par l'appelant). */
  defaultModelLabel: string;
  /** Modèle du Dot, sinon le défaut. */
  selectedModelLabel: string;
  /** Niveau de reasoning normalisé du Dot ('' = standard). */
  reasoningEffort: string;
  /** Libellé FR du niveau de raisonnement actuel. */
  reasoningLabel: string;
  /** Un cycle est en cours. */
  reasoningBusy: boolean;
  /** Passe au niveau de reasoning suivant. */
  cycleReasoning: () => Promise<void>;
}

export function useDotModelControls(options: {
  dotId: string | null;
  provider?: string | null;
  model?: string | null;
  /** Niveau actuel de reasoning du Dot ('' = standard). */
  reasoningEffort?: string | null;
  /** Repli pour le libellé du défaut quand le serveur n'en a pas. */
  fallbackDefaultModel?: string;
  /** Appelé au lancement du cycle (efface le champ d'erreur). */
  onReasoningStart?: () => void;
  /** Appelé après un changement de reasoning (refresh côté App/Chat). */
  onReasoningSaved?: () => void | Promise<void>;
  /** Reporter d'erreur du changement de reasoning. */
  onReasoningError?: (message: string) => void;
}): DotModelControls {
  const {
    dotId,
    provider,
    model,
    reasoningEffort,
    fallbackDefaultModel,
    onReasoningStart,
    onReasoningSaved,
    onReasoningError,
  } = options;
  const [models, setModels] = useState<ModelsResponse>({
    default: null,
    providers: [],
  });
  const [reasoningBusy, setReasoningBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      void api<ModelsResponse>('/models')
        .then((value) => {
          if (active) setModels(value);
        })
        .catch(() => {});
    load();
    const onChange = () => load();
    window.addEventListener('models-changed', onChange);
    return () => {
      active = false;
      window.removeEventListener('models-changed', onChange);
    };
  }, []);

  const modelValue = provider && model ? modelKey(provider, model) : '';
  const defaultModelLabel = models.default
    ? (models.default.model ?? models.default.provider)
    : (fallbackDefaultModel ?? '');
  const selectedModelLabel = model ?? defaultModelLabel;
  const effort = reasoningEffort ?? '';
  const reasoningLabel =
    effort === 'none'
      ? 'désactivée'
      : effort === 'low'
        ? 'basse'
        : effort === 'high'
          ? 'haute'
          : 'désactivée';

  const cycleReasoning = async () => {
    if (reasoningBusy || !dotId) return;
    const order = ['', 'low', 'high'];
    const next = order[(order.indexOf(effort) + 1) % order.length];
    setReasoningBusy(true);
    onReasoningStart?.();
    try {
      await api(`/dots/${dotId}/reasoning`, 'PUT', { effort: next || null });
      await onReasoningSaved?.();
    } catch (cause) {
      onReasoningError?.(
        cause instanceof Error
          ? cause.message
          : 'Réglage de réflexion indisponible.',
      );
    } finally {
      setReasoningBusy(false);
    }
  };

  return {
    models,
    modelValue,
    defaultModelLabel,
    selectedModelLabel,
    reasoningEffort: effort,
    reasoningLabel,
    reasoningBusy,
    cycleReasoning,
  };
}
