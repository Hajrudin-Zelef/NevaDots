import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type {
  CatalogModel,
  CatalogResponse,
  CreditsResponse,
  ModelsResponse,
  ProviderModels,
} from '../shared/models';

type KindFilter = 'all' | 'text' | 'image';

/** Notifies the composers to re-fetch `/models` after a provider change. */
function notifyModelsChanged() {
  window.dispatchEvent(new Event('models-changed'));
}

/** Tab icons per provider — cetas-lite's own SVGs, inlined (emoji don't render everywhere). */
const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  opencode: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#10b981"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <line x1="14" y1="4" x2="10" y2="20" />
    </svg>
  ),
  openrouter: (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
    >
      <path d="M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z" />
    </svg>
  ),
  deepseek: (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
    >
      <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
    </svg>
  ),
  freellmapi: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2 L22 12 L12 22 L2 12 Z" />
    </svg>
  ),
};

function ProviderIcon({ id }: { id: string }) {
  return (
    <span className="provider-tab-icon" aria-hidden="true">
      {PROVIDER_ICONS[id] ?? PROVIDER_ICONS.freellmapi}
    </span>
  );
}

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

      <section className="settings-card" aria-label="Fournisseur">
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
              <ProviderIcon id={item.id} />
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
              {saved === 'key' && (
                <span className="api-saved">Enregistré ✓</span>
              )}
            </div>
          </div>
        )}
      </section>

      {provider && (
        <section className="settings-card" aria-label="Modèles disponibles">
          <h3>Modèles disponibles</h3>
          <div className="api-catalog-tools">
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
            <div
              className="motion-skeleton-row"
              role="status"
              aria-label="Chargement des modèles…"
            >
              <div
                className="motion-skeleton motion-skeleton-line"
                style={{ width: '60%' }}
              />
              <div
                className="motion-skeleton motion-skeleton-line"
                style={{ width: '85%' }}
              />
              <div
                className="motion-skeleton motion-skeleton-line"
                style={{ width: '70%' }}
              />
            </div>
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
                    <label className="api-catalog-check">
                      <input
                        type="checkbox"
                        className="api-catalog-box"
                        checked={enabled.has(model.id)}
                        onChange={() => toggleModel(model.id)}
                      />
                      <span className="api-model-id" title={model.id}>
                        {model.id}
                      </span>
                    </label>
                    <span className="api-model-maker" title={model.maker ?? ''}>
                      {model.maker ?? ''}
                    </span>
                    <span className="api-model-price">{price ?? ''}</span>
                    <span
                      className="api-model-info"
                      title={modelTooltip(model)}
                    >
                      i
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
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
        <section className="settings-card" aria-label="Solde API">
          <h3>Solde API</h3>
          <ul className="api-credits-list">
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
        </section>
      )}

      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
