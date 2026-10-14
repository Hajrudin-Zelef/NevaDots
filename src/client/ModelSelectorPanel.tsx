import { useEffect, useState } from 'react';
import { api } from './api';
import type { Dot, WorkspaceState } from '../shared/types';
import {
  modelKey,
  parseModelKey,
  type ModelsResponse,
  type ProviderModels,
} from '../shared/models';

type DefaultRef = { provider: string; model: string | null };

/**
 * Model selector — matches NevaDots' backend model logic:
 * a global default (`model_default`) plus an optional per-Dot override
 * (`PUT /dots/:id/model`, null = back to the server default).
 * Resolution lives in `dot-agent.ts`: `dot.model ?? global default`.
 */
export function ModelSelectorPanel() {
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [defaultRef, setDefaultRef] = useState<DefaultRef | null>(null);
  const [dots, setDots] = useState<Dot[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let on = true;
    void api<ModelsResponse>('/models')
      .then((value) => {
        if (!on) return;
        setProviders(value.providers);
        setDefaultRef(value.default);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Chargement impossible.',
        ),
      );
    void api<WorkspaceState>('/workspace')
      .then((value) => {
        if (on) setDots(value.dots);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Dots introuvables.'),
      );
    return () => {
      on = false;
    };
  }, []);

  const changeDefault = async (next: DefaultRef) => {
    setDefaultRef(next);
    try {
      const result = await api<{ default: DefaultRef }>(
        '/model-default',
        'PUT',
        next,
      );
      setDefaultRef(result.default);
      setSaved('default');
      window.setTimeout(() => setSaved(''), 2500);
      window.dispatchEvent(new Event('models-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Défaut refusé.');
    }
  };

  const changeDotModel = async (dotId: string, value: string) => {
    const parsed = parseModelKey(value);
    try {
      await api(`/dots/${dotId}/model`, 'PUT', parsed ?? { model: null });
      setDots((current) =>
        current.map((dot) =>
          dot.id === dotId
            ? {
                ...dot,
                provider: parsed?.provider ?? null,
                model: parsed?.model ?? null,
              }
            : dot,
        ),
      );
      setSaved(`dot-${dotId}`);
      window.setTimeout(() => setSaved(''), 2500);
      window.dispatchEvent(new Event('models-changed'));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Modèle du Dot refusé.',
      );
    }
  };

  const defaultProvider = providers.find(
    (item) => item.id === (defaultRef?.provider ?? ''),
  );
  const defaultLabel =
    defaultRef?.model ?? defaultProvider?.models[0] ?? 'défaut';

  return (
    <div className="api-panel">
      <p className="config-note api-panel-intro">
        Le modèle par défaut s'applique à tous les Dots. Chaque Dot peut
        utiliser un autre modèle — sans choix explicite, il suit le défaut du
        serveur.
      </p>

      <section className="settings-card" aria-label="Modèle par défaut">
        <h3>Modèle par défaut</h3>
        <div className="api-default-controls">
          <select
            id="selector-default-provider"
            aria-label="Fournisseur par défaut"
            value={defaultRef?.provider ?? ''}
            onChange={(event) =>
              void changeDefault({ provider: event.target.value, model: null })
            }
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Modèle par défaut"
            value={defaultRef?.model ?? ''}
            onChange={(event) =>
              void changeDefault({
                provider: defaultRef?.provider ?? '',
                model: event.target.value || null,
              })
            }
          >
            <option value="">
              {defaultProvider?.models[0]
                ? `Défaut · ${defaultProvider.models[0]}`
                : 'Défaut du fournisseur'}
            </option>
            {(defaultProvider?.models ?? []).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          {saved === 'default' && (
            <span className="api-saved">Enregistré ✓</span>
          )}
        </div>
      </section>

      <section className="settings-card" aria-label="Modèles par Dot">
        <h3>Modèles par Dot</h3>
        {dots.length === 0 ? (
          <p className="muted">Aucun Dot pour le moment.</p>
        ) : (
          <ul className="model-dot-list">
            {dots.map((dot) => (
              <li key={dot.id} className="model-dot-row">
                <span className="model-dot-name" title={dot.name}>
                  {dot.name}
                </span>
                <select
                  aria-label={`Modèle pour ${dot.name}`}
                  value={
                    dot.provider && dot.model
                      ? modelKey(dot.provider, dot.model)
                      : ''
                  }
                  onChange={(event) =>
                    void changeDotModel(dot.id, event.target.value)
                  }
                >
                  <option value="">Défaut du serveur ({defaultLabel})</option>
                  {providers.map((provider) => (
                    <optgroup key={provider.id} label={provider.label}>
                      {provider.models.map((model) => (
                        <option
                          key={model}
                          value={modelKey(provider.id, model)}
                        >
                          {model}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {saved === `dot-${dot.id}` && (
                  <span className="api-saved">Enregistré ✓</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="config-note api-error">{error}</p>}
    </div>
  );
}
