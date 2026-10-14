import { useEffect, useState } from 'react';
import { api } from './api';
import {
  modelKey,
  parseModelKey,
  type ModelsResponse,
  type ProviderModels,
} from '../shared/models';

type DeepThinkSettings = {
  lang: string;
  provider: string;
  model: string;
};

const LANG_LABELS: Record<string, string> = {
  fr: 'Français',
  en: 'Anglais',
  es: 'Espagnol',
  de: 'Allemand',
  it: 'Italien',
};

/**
 * DeepThink Global — translation settings for the reasoning panel.
 * Language pills + translator model dropdown. Auto-saves on change.
 * The server (`POST /api/translate`) resolves the provider key from the
 * provider registry and falls back to the server default model.
 */
export function DeepThinkPanel() {
  const [langs, setLangs] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [settings, setSettings] = useState<DeepThinkSettings>({
    lang: 'fr',
    provider: '',
    model: '',
  });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    void api<{ settings: DeepThinkSettings; langs: string[] }>('/deepthink')
      .then((value) => {
        if (!on) return;
        setSettings(value.settings);
        setLangs(value.langs);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Chargement impossible.',
        ),
      );
    void api<ModelsResponse>('/models')
      .then((value) => {
        if (on) setProviders(value.providers);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  const persist = async (next: DeepThinkSettings) => {
    setSettings(next);
    setSaved(false);
    try {
      const result = await api<{ ok: boolean; settings: DeepThinkSettings }>(
        '/deepthink',
        'PUT',
        next,
      );
      setSettings(result.settings);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Enregistrement refusé.',
      );
    }
  };

  const translatorValue =
    settings.provider && settings.model
      ? modelKey(settings.provider, settings.model)
      : '';

  return (
    <div className="api-panel">
      <p className="config-note api-panel-intro">
        Règle la traduction du raisonnement affiché dans le panneau Raisonnement
        : langue cible et modèle traducteur.
      </p>

      <section
        className="settings-card"
        aria-label="Traduction du raisonnement"
      >
        <h3>Langue de traduction</h3>
        <div className="seg-row" role="group" aria-label="Langue cible">
          {langs.map((lang) => (
            <button
              key={lang}
              type="button"
              className={`seg-btn ${settings.lang === lang ? 'active' : ''}`}
              aria-pressed={settings.lang === lang}
              onClick={() => void persist({ ...settings, lang })}
            >
              {LANG_LABELS[lang] ?? lang}
            </button>
          ))}
        </div>

        <h3>Modèle traducteur</h3>
        <div className="api-default-controls">
          <select
            aria-label="Modèle traducteur"
            value={translatorValue}
            onChange={(event) => {
              const parsed = parseModelKey(event.target.value);
              void persist({
                ...settings,
                provider: parsed?.provider ?? '',
                model: parsed?.model ?? '',
              });
            }}
          >
            <option value="">Défaut du serveur</option>
            {providers.map((provider) => (
              <optgroup key={provider.id} label={provider.label}>
                {provider.models.map((model) => (
                  <option key={model} value={modelKey(provider.id, model)}>
                    {model}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {saved && <span className="api-saved">Enregistré ✓</span>}
        </div>
        <p className="muted">
          Sans choix, la traduction utilise le modèle par défaut du serveur et
          la clé du fournisseur configurée dans l'onglet API et Modèles.
        </p>
      </section>

      {error && <p className="config-note api-error">{error}</p>}
    </div>
  );
}
