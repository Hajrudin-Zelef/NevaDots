import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type {
  CatalogResponse,
  CreditsResponse,
  ModelsResponse,
  ProviderModels,
} from '../shared/models';

type DefaultRef = { provider: string; model: string | null };

/** Notifies the composers to re-fetch `/models` after a provider change. */
function notifyModelsChanged() {
  window.dispatchEvent(new Event('models-changed'));
}

export function ApiProvidersPanel() {
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [defaultRef, setDefaultRef] = useState<DefaultRef | null>(null);
  const [active, setActive] = useState('');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [credits, setCredits] = useState<CreditsResponse | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const loadCredits = useCallback(async () => {
    try {
      setCredits(await api<CreditsResponse>('/credits'));
    } catch {
      /* credits are best-effort */
    }
  }, []);

  useEffect(() => {
    let on = true;
    void api<ModelsResponse>('/models')
      .then((value) => {
        if (!on) return;
        setProviders(value.providers);
        setDefaultRef(value.default);
        setActive((prev) => prev || value.providers[0]?.id || '');
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Chargement impossible.',
        ),
      );
    void loadCredits();
    return () => {
      on = false;
    };
  }, [loadCredits]);

  useEffect(() => {
    if (!active) return;
    let on = true;
    setCatalogLoading(true);
    setCatalog(null);
    setSearch('');
    setKeyInput('');
    setReveal(false);
    void api<CatalogResponse>(`/catalog/${active}`)
      .then((value) => {
        if (on) setCatalog(value);
      })
      .catch((cause) => {
        if (on)
          setError(
            cause instanceof Error ? cause.message : 'Catalogue indisponible.',
          );
      })
      .finally(() => {
        if (on) setCatalogLoading(false);
      });
    return () => {
      on = false;
    };
  }, [active]);

  const flash = (label: string) => {
    setSaved(label);
    setTimeout(() => setSaved(''), 1400);
  };

  const provider = providers.find((item) => item.id === active);
  const enabled = new Set(provider?.models ?? []);

  const persistModels = useCallback(async (id: string, models: string[]) => {
    try {
      const result = await api<{ providers: ProviderModels[] }>(
        `/catalog/${id}`,
        'PUT',
        { models },
      );
      setProviders(result.providers);
      flash('models');
      notifyModelsChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Enregistrement échoué.',
      );
    }
  }, []);

  const toggleModel = (id: string) => {
    if (!provider) return;
    const next = new Set(provider.models);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const models = [...next];
    setProviders((current) =>
      current.map((item) =>
        item.id === provider.id ? { ...item, models } : item,
      ),
    );
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void persistModels(provider.id, models),
      700,
    );
  };

  const saveKey = async () => {
    if (!provider || !keyInput.trim()) return;
    setBusy('key');
    setError('');
    try {
      const result = await api<{ providers: ProviderModels[] }>(
        `/providers/${provider.id}`,
        'PUT',
        { key: keyInput.trim() },
      );
      setProviders(result.providers);
      setKeyInput('');
      setReveal(false);
      flash('key');
      notifyModelsChanged();
      void loadCredits();
      setActive(provider.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Clé refusée.');
    } finally {
      setBusy('');
    }
  };

  const removeKey = async () => {
    if (!provider) return;
    if (
      !window.confirm(`Supprimer la clé du fournisseur « ${provider.label} » ?`)
    )
      return;
    setBusy('key');
    try {
      const result = await api<{ providers: ProviderModels[] }>(
        `/providers/${provider.id}`,
        'DELETE',
      );
      setProviders(result.providers);
      void loadCredits();
      notifyModelsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Suppression échouée.');
    } finally {
      setBusy('');
    }
  };

  const changeDefault = async (next: DefaultRef) => {
    setDefaultRef(next);
    try {
      const result = await api<{ default: DefaultRef }>(
        '/model-default',
        'PUT',
        next,
      );
      setDefaultRef(result.default);
      flash('default');
      notifyModelsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Défaut refusé.');
    }
  };

  const defaultProvider = providers.find(
    (item) => item.id === defaultRef?.provider,
  );
  const filtered = (catalog?.models ?? []).filter((model) =>
    model.id.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="api-panel">
      <p className="config-note api-panel-intro">
        Clés et modèles par fournisseur. Les modèles cochés sont ceux proposés
        dans le sélecteur du composeur. Les clés sont chiffrées côté serveur et
        ne sont jamais renvoyées au navigateur.
      </p>

      <div className="api-default-row">
        <label className="field-label" htmlFor="api-default-provider">
          Modèle par défaut
        </label>
        <div className="api-default-controls">
          <select
            id="api-default-provider"
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
      </div>

      <div className="provider-tabs" role="tablist">
        {providers.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active}
            className={`provider-tab ${item.id === active ? 'active' : ''}`}
            onClick={() => setActive(item.id)}
          >
            <span className="provider-tab-label">{item.label}</span>
            <span
              className={`provider-status ${item.configured ? 'ok' : ''}`}
              title={item.configured ? 'Clé configurée' : 'Clé absente'}
            />
          </button>
        ))}
      </div>

      {provider && (
        <div className="provider-section">
          <div className="api-key-row">
            <label className="field-label" htmlFor="api-key-input">
              Clé API {provider.label}
            </label>
            {provider.keyUrl && (
              <a
                className="api-key-link"
                href={provider.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Obtenir une clé
              </a>
            )}
          </div>
          {provider.configured && (
            <div className="api-key-masked">
              <code>••••••••••••</code>
              <button
                type="button"
                className="connection-connect"
                disabled={busy === 'key'}
                onClick={() => void removeKey()}
              >
                Supprimer
              </button>
            </div>
          )}
          <div className="api-key-input">
            <input
              id="api-key-input"
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                provider.configured
                  ? 'Nouvelle clé (laisser vide pour conserver)'
                  : 'Coller la clé API…'
              }
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveKey();
              }}
            />
            <button
              type="button"
              className="api-eye"
              aria-label={reveal ? 'Masquer la clé' : 'Afficher la clé'}
              onClick={() => setReveal((value) => !value)}
            >
              {reveal ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="connection-connect"
              disabled={busy === 'key' || !keyInput.trim()}
              onClick={() => void saveKey()}
            >
              {busy === 'key' ? 'Validation…' : 'Valider'}
            </button>
            {saved === 'key' && <span className="api-saved">Enregistré ✓</span>}
          </div>

          <div className="api-catalog-head">
            <strong>Modèles disponibles</strong>
            <input
              className="api-catalog-search"
              placeholder="Rechercher un modèle…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {saved === 'models' && (
              <span className="api-saved">Enregistré ✓</span>
            )}
          </div>
          {catalogLoading && (
            <p className="config-note">Chargement des modèles…</p>
          )}
          {catalog?.error && (
            <p className="config-note">
              Catalogue live indisponible ({catalog.error}) — liste locale.
            </p>
          )}
          {!catalogLoading && filtered.length === 0 && (
            <p className="config-note">
              Aucun modèle. Ajoute une clé pour charger la liste du fournisseur.
            </p>
          )}
          {!catalogLoading && filtered.length > 0 && (
            <ul className="api-catalog-list">
              {filtered.map((model) => (
                <li key={model.id} className="api-catalog-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={enabled.has(model.id)}
                      onChange={() => toggleModel(model.id)}
                    />
                    <span className="api-model-id">{model.id}</span>
                    {model.name && model.name !== model.id && (
                      <span className="api-model-name">{model.name}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {credits && credits.credits.length > 0 && (
        <div className="api-credits">
          <strong>Solde API</strong>
          <ul>
            {credits.credits.map((entry) => (
              <li key={entry.provider}>
                <span className="api-credit-label">{entry.label}</span>
                <span className="api-credit-value">
                  {!entry.configured
                    ? 'clé absente'
                    : !entry.supported
                      ? 'non disponible'
                      : entry.error
                        ? `erreur (${entry.error})`
                        : entry.balance === undefined
                          ? (entry.detail ?? 'non disponible')
                          : `${entry.balance.toFixed(2)} ${entry.currency ?? ''}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
