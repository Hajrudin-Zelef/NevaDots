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
  /** Niveau de reasoning normalisé du Dot ('auto' = Défaut, '' = Standard). */
  reasoningEffort: string;
  /** Libellé FR du niveau de raisonnement actuel. */
  reasoningLabel: string;
  /** Un changement est en cours. */
  reasoningBusy: boolean;
  /** Fixe le niveau de reasoning (PUT `/dots/:id/reasoning`). */
  setReasoningEffort: (effort: string | null) => Promise<void>;
  /** Niveaux natifs du modèle courant : `undefined` = chargement,
   *  `null` = en attente (provider sans source fiable). */
  reasoningLevels?: string[] | null;
  /** Raisonnement obligatoire côté provider (pas de `none`). */
  reasoningMandatory: boolean;
}

/** Libellé FR d'un niveau (partagé : composer, rail, réglages). */
export function reasoningEffortLabel(
  effort: string | null | undefined,
): string {
  switch (effort ?? 'auto') {
    case 'none':
      return 'désactivée';
    case 'low':
      return 'basse';
    case 'medium':
      return 'moyenne';
    case 'high':
      return 'haute';
    case 'max':
      return 'max';
    default:
      return 'standard';
  }
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
  const [reasoningLevels, setReasoningLevels] = useState<
    string[] | null | undefined
  >(undefined);
  const [reasoningMandatory, setReasoningMandatory] = useState(false);

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
      window.removeEventListener?.('models-changed', onChange);
    };
  }, []);

  // Niveaux natifs du modèle courant (sélecteur de variantes).
  useEffect(() => {
    let active = true;
    if (!provider || !model) {
      setReasoningLevels(undefined);
      setReasoningMandatory(false);
      return;
    }
    setReasoningLevels(undefined);
    setReasoningMandatory(false);
    void api<{
      status: 'known' | 'unknown' | 'pending';
      levels?: string[];
      mandatory?: boolean;
    }>(
      `/reasoning-levels?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    )
      .then((value) => {
        if (!active) return;
        if (value.status === 'pending') setReasoningLevels(null);
        else if (value.status === 'known')
          setReasoningLevels(Array.isArray(value.levels) ? value.levels : []);
        else setReasoningLevels(undefined);
        setReasoningMandatory(value.mandatory === true);
      })
      .catch(() => {
        if (!active) return;
        setReasoningLevels(undefined);
        setReasoningMandatory(false);
      });
    return () => {
      active = false;
    };
  }, [provider, model]);

  const modelValue = provider && model ? modelKey(provider, model) : '';
  const defaultModelLabel = models.default
    ? (models.default.model ?? models.default.provider)
    : (fallbackDefaultModel ?? '');
  const selectedModelLabel = model ?? defaultModelLabel;
  const effort = reasoningEffort ?? 'auto';
  const reasoningLabel = reasoningEffortLabel(effort);

  const setReasoningEffort = async (next: string | null) => {
    if (reasoningBusy || !dotId) return;
    setReasoningBusy(true);
    onReasoningStart?.();
    try {
      await api(`/dots/${dotId}/reasoning`, 'PUT', { effort: next });
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
    setReasoningEffort,
    reasoningLevels,
    reasoningMandatory,
  };
}
