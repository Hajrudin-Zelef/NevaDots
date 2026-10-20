import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';

interface SkillPolicy {
  enabled: boolean;
  allowedUsers: string[] | null;
}
interface SkillUsageRow {
  userId: string;
  dotId: string;
  skillId: string;
  loads: number;
  lastUsedAt: number;
}
interface AccountRef {
  id: string;
  username: string;
}

function fmtDate(value: number): string {
  return new Date(value).toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/**
 * Gouvernance Admin des skills locaux : kill switch global, allowlist par
 * compte et vue d'usage. Fail-closed : le serveur revérifie la politique à
 * chaque appel d'outil et interrompt le run courant si elle change.
 */
export function SkillsAdminPanel({ users }: { users: AccountRef[] }) {
  const [policy, setPolicy] = useState<SkillPolicy | null>(null);
  const [usage, setUsage] = useState<SkillUsageRow[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ policy: SkillPolicy; usage: SkillUsageRow[] }>(
        '/skills/policy',
      );
      setPolicy(data.policy);
      setUsage(data.usage);
    } catch {
      /* 403 pour un non-Admin : panneau masqué par l'onglet Comptes */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const allowed = useMemo(
    () => new Set(policy?.allowedUsers ?? users.map((user) => user.id)),
    [policy, users],
  );

  const save = async () => {
    if (!policy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const data = await api<{ policy: SkillPolicy }>('/skills/policy', 'PUT', {
        enabled: policy.enabled,
        allowedUsers: policy.allowedUsers,
      });
      setPolicy(data.policy);
      setSaved(
        'Politique enregistrée. Le run en cours est interrompu si elle change.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Impossible d’enregistrer la politique.',
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleUser = (userId: string, checked: boolean) => {
    if (!policy) return;
    const current = new Set(allowed);
    if (checked) current.add(userId);
    else current.delete(userId);
    setPolicy({ ...policy, allowedUsers: [...current] });
  };

  if (!policy) return null;
  return (
    <fieldset className="prefs-section">
      <legend>Skills locaux (bibliothèque du host)</legend>
      <p className="muted">
        87 procédures indexées, chargées à la demande par les Dots. Le Dot doit
        aussi avoir son propre interrupteur « Skills locaux » activé.
      </p>
      <label className="permission-row">
        <input
          type="checkbox"
          checked={policy.enabled}
          onChange={(event) =>
            setPolicy({ ...policy, enabled: event.target.checked })
          }
        />
        <span>
          <strong>Autoriser les skills sur l’instance</strong>
          <small>
            Kill switch global. Décoché, les outils de skills disparaissent et
            tout run en cours est interrompu.
          </small>
        </span>
      </label>
      <div className="prefs-field">
        <span className="prefs-field-label">Comptes autorisés</span>
        <div className="dot-model-list">
          {users.map((user) => (
            <label className="dot-model-row" key={user.id}>
              <input
                type="checkbox"
                checked={allowed.has(user.id)}
                onChange={(event) => toggleUser(user.id, event.target.checked)}
              />
              <span className="dot-model-name">{user.username}</span>
            </label>
          ))}
          {users.length === 0 && <p className="muted">Aucun compte.</p>}
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => setPolicy({ ...policy, allowedUsers: null })}
        >
          Tous les comptes (présents et futurs)
        </button>
      </div>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => void save()}
      >
        Enregistrer la politique
      </button>
      {error && <p className="chat-error">{error}</p>}
      {saved && <p className="muted">{saved}</p>}

      <h4 className="prefs-section-title">Usage des skills</h4>
      <div className="dot-model-list">
        {usage.slice(0, 20).map((row) => (
          <div
            className="dot-model-row"
            key={`${row.userId}:${row.dotId}:${row.skillId}`}
          >
            <span className="dot-model-name">
              {row.skillId}
              <span className="dot-model-meta">
                {users.find((user) => user.id === row.userId)?.username ??
                  row.userId}{' '}
                · Dot {row.dotId.slice(0, 8)} · {row.loads} chargement
                {row.loads > 1 ? 's' : ''} · {fmtDate(row.lastUsedAt)}
              </span>
            </span>
          </div>
        ))}
        {usage.length === 0 && (
          <p className="muted">Aucun skill chargé pour l’instant.</p>
        )}
      </div>
    </fieldset>
  );
}
