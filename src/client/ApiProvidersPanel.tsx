import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type {
  CatalogModel,
  CatalogResponse,
  CreditsResponse,
  ModelsResponse,
  ProviderModels,
} from '../shared/models';

type DefaultRef = { provider: string; model: string | null };
type KindFilter = 'all' | 'text' | 'image';

/** Notifies the composers to re-fetch `/models` after a provider change. */
function notifyModelsChanged() {
  window.dispatchEvent(new Event('models-changed'));
}

/** Tab icons per provider (cetas-lite uses SVG logos; emoji stay CSP-safe). */
const PROVIDER_ICONS: Record<string, string> = {
  opencode: '⬡',
  openrouter: '🔀',
  deepseek: '🐋',
  freellmapi: '🆓',
};

/** `"$2.50 — $7.50 /M"`, `"Gratuit"` when both are 0, null when unknown. */
function priceStr(model: CatalogModel): string | null {
  const { promptPer1M: p, completionPer1M: c } = model;
  if (p === undefined && c === undefined) return null;
  if ((p ?? 0) === 0 && (c ?? 0) === 0) return 'Gratuit';
  const fmt = (n: number) =>
    `$${n.toLocaleString('en-US', { maximumFractionDigits: 3 })}`;
  return `${fmt(p ?? 0)} — ${fmt(c ?? 0)} /M`;
}

/** Tooltip text for the info badge: name, maker, context, description. */
function modelTooltip(model: CatalogModel): string {
  const parts: string[] = [];
  parts.push(model.name && model.name !== model.id ? model.name : model.id);
  if (model.maker) parts.push(`Fabricant : ${model.maker}`);
  if (model.contextLength)
    parts.push(
      `Contexte : ${model.contextLength.toLocaleString('fr-FR')} tokens`,
    );
  if (model.description) parts.push(model.description);
  return parts.join('\n');
}

const KIND_LABELS: Record<KindFilter, string> = {
  all: 'Tous',
  text: 'Textes',
  image: 'Images',
};

export function ApiProvidersPanel() {
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [defaultRef, setDefaultRef] = useState<DefaultRef | null>(null);
  const [active, setActive] = useState('');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [maker, setMaker] = useState('all');
  /** Typed (not yet validated) keys, kept per provider so tab switches keep them. */
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
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

  const loadCatalog = useCallback(
    async (providerId: string, refresh: boolean, isOn: () => boolean) => {
      setCatalogLoading(true);
      if (refresh) setCatalog(null);
      try {
        const value = await api<CatalogResponse>(
          `/catalog/${providerId}${refresh ? '?refresh=1' : ''}`,
        );
        if (isOn()) setCatalog(value);
      } catch (cause) {
        if (isOn())
          setError(
            cause instanceof Error ? cause.message : 'Catalogue indisponible.',
          );
      } finally {
        if (isOn()) setCatalogLoading(false);
      }
    },
    [],
  );

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
    const isOn = () => on;
    setCatalog(null);
    setSearch('');
    setKind('all');
    setMaker('all');
    setReveal(false);
    void loadCatalog(active, false, isOn);
    return () => {
      on = false;
    };
  }, [active, loadCatalog]);

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

  /** Core key PUT shared by single save and save-all. No busy handling. */
  const putKey = useCallback(
    async (providerId: string, key: string): Promise<boolean> => {
      try {
        const result = await api<{ providers: ProviderModels[] }>(
          `/providers/${providerId}`,
          'PUT',
          { key },
        );
        setProviders(result.providers);
        setKeyInputs((current) => ({ ...current, [providerId]: '' }));
        setReveal(false);
        notifyModelsChanged();
        void loadCredits();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Clé refusée.');
        return false;
      }
    },
    [loadCredits],
  );

  const saveKey = () => {
    const key = (keyInputs[active] ?? '').trim();
    if (!provider || !key || busy) return;
    setBusy('key');
    setError('');
    void putKey(provider.id, key).then((ok) => {
      if (ok) flash('key');
      setBusy('');
    });
  };

  /** Validates every typed-but-unsaved key (cetas-lite's "Sauvegarder tout"). */
  const saveAllKeys = () => {
    const pending = providers.filter((item) =>
      (keyInputs[item.id] ?? '').trim(),
    );
    if (!pending.length || busy) return;
    setBusy('all');
    setError('');
    void (async () => {
      let failed = 0;
      for (const item of pending) {
        const ok = await putKey(item.id, (keyInputs[item.id] ?? '').trim());
        if (!ok) failed += 1;
      }
      if (failed === 0) flash('all');
      setBusy('');
    })();
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

  const refreshCatalog = () => {
    if (!active || busy) return;
    setBusy('refresh');
    setError('');
    void loadCatalog(active, true, () => true).finally(() => setBusy(''));
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
  const models = catalog?.models ?? [];
  const makers = [...new Set(models.map((m) => m.maker).filter(Boolean))].sort(
    (a, b) => a!.localeCompare(b!, 'fr'),
  ) as string[];
  const hasImages = models.some((m) => m.isImage);
  const query = search.trim().toLowerCase();
  const filtered = models.filter((model) => {
    if (kind === 'image' && !model.isImage) return false;
    if (kind === 'text' && model.isImage) return false;
    if (maker !== 'all' && model.maker !== maker) return false;
    if (
      query &&
      !`${model.id} ${model.name ?? ''}`.toLowerCase().includes(query)
    )
      return false;
    return true;
  });
  const hasPendingKeys = providers.some((item) =>
    (keyInputs[item.id] ?? '').trim(),
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
            <span className="provider-tab-icon" aria-hidden="true">
              {PROVIDER_ICONS[item.id] ?? '🔌'}
            </span>
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
              value={keyInputs[provider.id] ?? ''}
              onChange={(event) =>
                setKeyInputs((current) => ({
                  ...current,
                  [provider.id]: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey();
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
              disabled={
                busy === 'key' || !(keyInputs[provider.id] ?? '').trim()
              }
              onClick={saveKey}
            >
              {busy === 'key' ? 'Validation…' : 'Valider'}
            </button>
            {saved === 'key' && <span className="api-saved">Enregistré ✓</span>}
          </div>

          <div className="api-catalog-head">
            <strong>Modèles disponibles</strong>
            {hasImages && (
              <div
                className="api-kind-seg"
                role="group"
                aria-label="Type de modèle"
              >
                {(Object.keys(KIND_LABELS) as KindFilter[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`api-kind-btn ${kind === k ? 'active' : ''}`}
                    onClick={() => setKind(k)}
                  >
                    {KIND_LABELS[k]}
                  </button>
                ))}
              </div>
            )}
            {makers.length > 1 && (
              <select
                className="api-category-select"
                aria-label="Catégorie"
                value={maker}
                onChange={(event) => setMaker(event.target.value)}
              >
                <option value="all">Toutes les catégories</option>
                {makers.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            <input
              className="api-catalog-search"
              placeholder="Rechercher un modèle…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="api-refresh-btn"
              title="Actualiser le catalogue"
              aria-label="Actualiser le catalogue"
              disabled={busy === 'refresh'}
              onClick={refreshCatalog}
            >
              {busy === 'refresh' ? '…' : '↻'}
            </button>
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
              {filtered.map((model) => {
                const price = priceStr(model);
                return (
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
                    <span className="api-model-meta">
                      {price && (
                        <span className="api-model-price">{price}</span>
                      )}
                      <span
                        className="api-model-info"
                        title={modelTooltip(model)}
                      >
                        i
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {hasPendingKeys && (
        <div className="api-save-all-row">
          <button
            type="button"
            className="api-save-all"
            disabled={busy === 'all'}
            onClick={saveAllKeys}
          >
            {busy === 'all' ? 'Sauvegarde…' : 'Tout sauvegarder'}
          </button>
          {saved === 'all' && <span className="api-saved">Enregistré ✓</span>}
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
