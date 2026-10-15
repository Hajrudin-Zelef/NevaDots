import { useEffect, useState } from 'react';
import { api } from './api';

type ConnectorField = {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
};
type Connector = {
  id: string;
  name: string;
  desc: string;
  fields: ConnectorField[];
  connected: boolean;
  login: string;
  manual: boolean;
};

const FAVS_KEY = 'nevadots-conn-favs';
const NAMES_KEY = 'nevadots-conn-names';

function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAVS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function loadNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

/** Real brand marks, inlined (same approach as the provider tab icons). */
const LOGOS: Record<string, React.ReactNode> = {
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  ),
  gitlab: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M12 2 9.5 8.5H2.6l2.5 2 1.6 4.9-3.5 2.6 7.8 5.7 7.8-5.7-3.5-2.6 1.6-4.9 2.5-2H14.5L12 2Z"
        opacity=".9"
      />
      <path
        d="M12 2v22l-7.8-5.7 3.5-2.6-1.6-4.9-2.5-2h6.9L12 2Z"
        opacity=".55"
      />
    </svg>
  ),
  slack: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M9.5 2.5a2.5 2.5 0 0 1 2.5 2.5v3H9.5a2.5 2.5 0 0 1 0-5.5ZM9.5 2.5h4.5M14.5 2.5a2.5 2.5 0 0 1 0 5.5M21.5 9.5a2.5 2.5 0 0 1-2.5 2.5h-3v-2.5a2.5 2.5 0 0 1 5.5 0ZM21.5 9.5v4.5M21.5 14.5a2.5 2.5 0 0 1-5.5 0M14.5 21.5a2.5 2.5 0 0 1-2.5-2.5v-3h2.5a2.5 2.5 0 0 1 0 5.5ZM14.5 21.5H10M9.5 21.5a2.5 2.5 0 0 1 0-5.5M2.5 14.5a2.5 2.5 0 0 1 2.5-2.5h3v2.5a2.5 2.5 0 0 1-5.5 0ZM2.5 14.5V10"
        stroke="currentColor"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  ),
  discord: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.6 5.1A16.4 16.4 0 0 0 15.5 4l-.5 1a15 15 0 0 0-6 0L8.5 4a16.4 16.4 0 0 0-4.1 1.1C1.8 9.2 1.2 13.2 1.5 17.1A16.6 16.6 0 0 0 6.6 20l1.2-2a10 10 0 0 1-1.9-.9l.5-.3a12 12 0 0 0 10.2 0l.5.3c-.6.4-1.2.7-1.9.9l1.2 2a16.6 16.6 0 0 0 5.1-2.9c.4-4.5-.7-8.4-2.9-11.9ZM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  ),
  notion: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm4.2 4.5v9.7l6.1-3.9v-4.4l-3.4 2.2v3.1l-1.2.8V9.2l3.9-2.5 2.6-1.1v11.2l-7.6 4.7V7.5Z" />
    </svg>
  ),
  linear: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4 4h4.5L20 15.5V20h-4.5L4 8.5V4Z" opacity=".95" />
      <path d="M13 4h4.5L20 6.5V11L13 4Z" opacity=".6" />
      <path d="M4 13v4.5L6.5 20H11L4 13Z" opacity=".6" />
    </svg>
  ),
  stripe: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3c-3.5 0-5.5 1.7-5.5 4.2 0 3.1 4.3 3.6 6.6 4.2 1.7.5 2.4 1 2.4 2 0 1.2-1.2 2-3 2-1.9 0-3.5-.9-4-1.2l-1 2.2c.9.5 2.8 1.3 5 1.3 3.7 0 6-1.9 6-4.6 0-3.2-4-3.9-6.5-4.5-1.8-.4-2.6-.9-2.6-1.9 0-1 1-1.7 2.7-1.7 1.6 0 3 .7 3.5 1l1-2.1C16 3.5 14.2 3 12 3Z" />
    </svg>
  ),
  dropbox: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.5 3 12 6.5 6.5 10 1 6.5 6.5 3Zm11 0L23 6.5 17.5 10 12 6.5l5.5-3.5ZM1 13.5l5.5 3.5L12 13.5 6.5 10 1 13.5Zm11 0 5.5 3.5L23 13.5 17.5 10 12 13.5Zm-5.5 3.5L12 20.5 17.5 17 12 13.5 6.5 17Z" />
    </svg>
  ),
  trello: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect
        x="6.5"
        y="7.5"
        width="4.5"
        height="9"
        rx="1"
        fill="var(--nd-bg, #fff)"
      />
      <rect
        x="13"
        y="7.5"
        width="4.5"
        height="5.5"
        rx="1"
        fill="var(--nd-bg, #fff)"
      />
    </svg>
  ),
  huggingface: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M12 2a8.5 8.5 0 0 0-8.5 8.5c0 2.6 1.2 5 3 6.6.4 2.1 1.6 3.9 3.4 3.9 1.2 0 1.9-.7 2.1-.7s.9.7 2.1.7c1.8 0 3-1.8 3.4-3.9 1.8-1.6 3-4 3-6.6A8.5 8.5 0 0 0 12 2Z"
        fill="#FFD21F"
      />
      <circle cx="9" cy="11" r="1.3" fill="#1a1a1a" />
      <circle cx="15" cy="11" r="1.3" fill="#1a1a1a" />
      <path
        d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"
        stroke="#1a1a1a"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  ),
  manual: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 4l3 3M14 7l3 3" />
    </svg>
  ),
  gmail: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="2.5"
        y="5"
        width="19"
        height="14"
        rx="2.5"
        fill="#fff"
        stroke="#9aa0a6"
        strokeWidth="1"
      />
      <path
        d="M3.5 7.5 12 13l8.5-5.5"
        fill="none"
        stroke="#EA4335"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  drive: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3h8l8 14h-8L8 3Z" fill="#FFC107" />
      <path d="M8 3 0 17l4 4 8-14-4-4Z" fill="#4CAF50" />
      <path d="M16 3l8 14-4 4H4l4-4h12l-4-14Z" fill="#2196F3" opacity=".85" />
    </svg>
  ),
  onedrive: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3 7 8.5 12 14l5-5.5L12 3Z" opacity=".9" />
      <path d="M7 8.5 2.5 14 7 19.5 12 14 7 8.5Z" opacity=".65" />
      <path d="M17 8.5 21.5 14 17 19.5 12 14l5-5.5Z" opacity=".65" />
      <path d="M7 19.5h10L12 14 7 19.5Z" opacity=".45" />
    </svg>
  ),
  mega: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#D9272E" />
      <path
        d="M7 16.5v-9l5 4.5 5-4.5v9"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  sftp: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </svg>
  ),
};

function Logo({ id }: { id: string }) {
  return (
    <span className="provider-tab-icon" aria-hidden="true">
      {LOGOS[id] ?? LOGOS.manual}
    </span>
  );
}

/**
 * External service accounts — 10 pre-configured connectors with real logos
 * plus a manual connector. Green dot = connected. ⋮ menu: favorites, rename,
 * delete. Credentials are validated live then encrypted server-side.
 */
export function ExternalAccountsSection() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const [names, setNames] = useState<Record<string, string>>(loadNames);
  const [formId, setFormId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    void api<{ connectors: Connector[] }>('/external-accounts')
      .then((value) => {
        setConnectors(value.connectors);
        setLoaded(true);
      })
      .catch((cause) => {
        setLoaded(true);
        setError(
          cause instanceof Error ? cause.message : 'Chargement impossible.',
        );
      });
  };
  useEffect(() => {
    load();
  }, []);

  const saveFavs = (next: string[]) => {
    setFavs(next);
    localStorage.setItem(FAVS_KEY, JSON.stringify(next));
  };
  const saveNames = (next: Record<string, string>) => {
    setNames(next);
    localStorage.setItem(NAMES_KEY, JSON.stringify(next));
  };

  const displayName = (c: Connector) => names[c.id] ?? c.name;

  const connect = async (c: Connector) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ ok: boolean; login: string }>(
        `/external-accounts/${encodeURIComponent(c.id)}`,
        'PUT',
        { values },
      );
      setConnectors((list) =>
        list.map((item) =>
          item.id === c.id
            ? { ...item, connected: true, login: result.login }
            : item,
        ),
      );
      setValues({});
      setFormId(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Connexion impossible.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Connector) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/external-accounts/${encodeURIComponent(c.id)}`, 'DELETE');
      if (c.manual) {
        setConnectors((list) => list.filter((item) => item.id !== c.id));
      } else {
        setConnectors((list) =>
          list.map((item) =>
            item.id === c.id ? { ...item, connected: false, login: '' } : item,
          ),
        );
        const next = { ...names };
        delete next[c.id];
        saveNames(next);
      }
      setConfirmDelete(null);
      setMenuId(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Suppression impossible.',
      );
    } finally {
      setBusy(false);
    }
  };

  const createManual = async () => {
    if (busy || !manualName.trim() || !manualSecret.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/external-accounts/manual', 'POST', {
        name: manualName.trim(),
        secret: manualSecret.trim(),
      });
      setManualName('');
      setManualSecret('');
      setManualOpen(false);
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...connectors].sort((a, b) => {
    const fa = favs.includes(a.id) ? 0 : 1;
    const fb = favs.includes(b.id) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return displayName(a).localeCompare(displayName(b), 'fr');
  });
  const connected = sorted.filter((c) => c.connected);
  const available = sorted.filter((c) => !c.connected);

  const renderCard = (c: Connector) => (
    <div className="external-account" key={c.id}>
      <div className="external-account-head">
        <Logo id={c.id} />
        <div className="external-account-info">
          <strong>
            {favs.includes(c.id) && <span aria-hidden="true">★ </span>}
            {displayName(c)}
          </strong>
          <span className="muted">
            {c.connected ? `Connecté · ${c.login}` : c.desc}
          </span>
        </div>
        <span
          className={`provider-status ${c.connected ? 'ok' : ''}`}
          title={c.connected ? `Connecté · ${c.login}` : 'Déconnecté'}
        />
        <div className="external-menu-wrap">
          <button
            type="button"
            className="icon-button"
            aria-label={`Options pour ${displayName(c)}`}
            aria-haspopup="menu"
            onClick={() => {
              setMenuId(menuId === c.id ? null : c.id);
              setConfirmDelete(null);
              setRenaming(null);
            }}
          >
            ⋮
          </button>
          {menuId === c.id && (
            <>
              <div
                className="external-menu-backdrop"
                onClick={() => {
                  setMenuId(null);
                  setRenaming(null);
                  setConfirmDelete(null);
                }}
              />
              <div className="external-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const next = favs.includes(c.id)
                      ? favs.filter((id) => id !== c.id)
                      : [...favs, c.id];
                    saveFavs(next);
                    setMenuId(null);
                  }}
                >
                  {favs.includes(c.id)
                    ? '★ Retirer des favoris'
                    : '☆ Ajouter aux favoris'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRenaming(c.id);
                    setRenameValue(displayName(c));
                    setConfirmDelete(null);
                  }}
                >
                  Renommer
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setConfirmDelete(c.id);
                    setRenaming(null);
                  }}
                >
                  {c.manual ? 'Supprimer' : 'Dissocier'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {renaming === c.id && (
        <div className="external-account-form">
          <input
            value={renameValue}
            maxLength={40}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = renameValue.trim();
                if (v) saveNames({ ...names, [c.id]: v });
                setRenaming(null);
                setMenuId(null);
              }
              if (e.key === 'Escape') setRenaming(null);
            }}
            aria-label={`Nouveau nom pour ${c.name}`}
          />
          <button
            type="button"
            className="connection-connect"
            onClick={() => {
              const v = renameValue.trim();
              if (v) saveNames({ ...names, [c.id]: v });
              setRenaming(null);
              setMenuId(null);
            }}
          >
            OK
          </button>
        </div>
      )}

      {confirmDelete === c.id && (
        <div className="external-account-row">
          <span className="muted">
            {c.manual ? 'Supprimer ce connecteur ?' : 'Dissocier ce compte ?'}
          </span>
          <button
            type="button"
            className="connection-connect"
            disabled={busy}
            onClick={() => void remove(c)}
          >
            {busy ? '…' : 'Confirmer'}
          </button>
          <button
            type="button"
            className="api-eye"
            disabled={busy}
            onClick={() => setConfirmDelete(null)}
          >
            Annuler
          </button>
        </div>
      )}

      {!c.connected && formId !== c.id && (
        <div className="external-account-row">
          <button
            type="button"
            className="connection-connect"
            onClick={() => {
              setFormId(c.id);
              setValues({});
              setError('');
              setMenuId(null);
            }}
          >
            Associer
          </button>
        </div>
      )}

      {!c.connected && formId === c.id && (
        <div className="external-account-form">
          {c.fields.map((field) => (
            <input
              key={field.key}
              type={field.type}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.placeholder}
              aria-label={field.label}
              title={field.label}
              value={values[field.key] ?? ''}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field.key]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect(c);
                if (e.key === 'Escape') setFormId(null);
              }}
            />
          ))}
          <button
            type="button"
            className="connection-connect"
            disabled={busy}
            onClick={() => void connect(c)}
          >
            {busy ? 'Vérification…' : 'Connecter'}
          </button>
          <button
            type="button"
            className="api-eye"
            disabled={busy}
            onClick={() => {
              setFormId(null);
              setValues({});
              setError('');
            }}
          >
            Annuler
          </button>
        </div>
      )}
    </div>
  );

  return (
    <section className="settings-card" aria-label="Comptes externes">
      <h3>Comptes externes</h3>
      <p className="muted">
        Comptes utilisables par l'agent. Le secret est vérifié en direct puis
        chiffré — il ne transite jamais vers le navigateur.
      </p>

      {connected.length > 0 && (
        <>
          <h4 className="external-section-title">Connectés</h4>
          <div className="external-grid">{connected.map(renderCard)}</div>
        </>
      )}

      <h4 className="external-section-title">Disponibles</h4>
      {!loaded ? (
        <div
          className="external-grid"
          role="status"
          aria-label="Chargement des connecteurs…"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="motion-skeleton motion-skeleton-card" />
          ))}
        </div>
      ) : (
        <div className="external-grid">{available.map(renderCard)}</div>
      )}

      <div className="external-account">
        <div className="external-account-head">
          <Logo id="manual" />
          <div className="external-account-info">
            <strong>Connecteur manuel</strong>
            <span className="muted">
              Un nom et un secret, chiffré comme les autres.
            </span>
          </div>
        </div>
        {manualOpen ? (
          <div className="external-account-form">
            <input
              value={manualName}
              maxLength={40}
              placeholder="Nom du connecteur…"
              aria-label="Nom du connecteur manuel"
              onChange={(e) => setManualName(e.target.value)}
            />
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={manualSecret}
              placeholder="Secret…"
              aria-label="Secret du connecteur manuel"
              onChange={(e) => setManualSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createManual();
                if (e.key === 'Escape') setManualOpen(false);
              }}
            />
            <button
              type="button"
              className="connection-connect"
              disabled={busy || !manualName.trim() || !manualSecret.trim()}
              onClick={() => void createManual()}
            >
              {busy ? '…' : 'Créer'}
            </button>
            <button
              type="button"
              className="api-eye"
              disabled={busy}
              onClick={() => setManualOpen(false)}
            >
              Annuler
            </button>
          </div>
        ) : (
          <div className="external-account-row">
            <button
              type="button"
              className="connection-connect"
              onClick={() => setManualOpen(true)}
            >
              + Ajouter
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="config-note api-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
