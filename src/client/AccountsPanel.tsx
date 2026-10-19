import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ProviderModels } from '../shared/models';

/** Compte (Phase E) : tel que GET /api/auth/users le renvoie (sans hash). */
interface AccountUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  monthlyLimitUsd: number | null;
  maxDots: number | null;
}
interface AuditEvent {
  id: number;
  action: string;
  username: string;
  ip: string;
  at: number;
}

type TaskProfile =
  'code' | 'recherche' | 'redaction' | 'polyvalent' | 'personnalise';
const PROFILE_LABELS: Record<TaskProfile, string> = {
  code: 'Code',
  recherche: 'Recherche',
  redaction: 'Rédaction',
  polyvalent: 'Polyvalent',
  personnalise: 'Personnalisé',
};
/**
 * Profils de tâches (Phase E, raccourcis) : sous-chaînes comparées
 * (insensible à la casse) aux ids de modèles. Un provider est pré-coché
 * s'il a au moins un modèle correspondant. Polyvalent = tout coché,
 * Personnalisé = rien de coché (l'Admin choisit). L'Admin ajuste ensuite :
 * seule la liste finale est enregistrée.
 */
const PROFILE_MODEL_PATTERNS: Record<TaskProfile, string[] | 'all' | 'none'> = {
  code: [
    'code',
    'sonnet',
    'opus',
    'o1',
    'o3',
    'gpt-5',
    'gemini-2',
    'gemini-3',
    'qwen3',
    'deepseek',
    'coder',
  ],
  recherche: [
    'sonnet',
    'opus',
    'gpt-5',
    'gemini',
    'o1',
    'o3',
    '128k',
    '200k',
    '1m',
    'deepseek',
  ],
  redaction: ['sonnet', 'opus', 'gpt-5', 'gemini', 'claude', 'o1', 'o3'],
  polyvalent: 'all',
  personnalise: 'none',
};

const AUDIT_LABELS: Record<string, string> = {
  login_ok: 'Connexion',
  login_failed: 'Connexion échouée',
  password_reset: 'Mot de passe réinitialisé',
  reset_failed: 'Reset échoué',
  bootstrap_ok: 'Bootstrap',
  bootstrap_failed: 'Bootstrap échoué',
  user_created: 'Compte créé',
  user_updated: 'Compte modifié',
  user_deleted: 'Compte supprimé',
  user_delete_failed: 'Suppression échouée',
  password_changed: 'Mot de passe changé',
};

function fmtDate(at: number) {
  return new Date(at).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AccountsPanel() {
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<AccountUser | null>(null);
  const [deleting, setDeleting] = useState<AccountUser | null>(null);
  const [masterPassword, setMasterPassword] = useState('');
  // Formulaire.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [profile, setProfile] = useState<TaskProfile>('polyvalent');
  const [checkedProviders, setCheckedProviders] = useState<string[]>([]);
  const [checkedModels, setCheckedModels] = useState<string[]>([]);
  const [monthlyLimit, setMonthlyLimit] = useState('');
  const [maxDots, setMaxDots] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [usersRes, auditRes, providersRes] = await Promise.all([
        api<{ users: AccountUser[] }>('/auth/users'),
        api<{ events: AuditEvent[] }>('/auth/audit'),
        api<{ providers: ProviderModels[] }>('/providers'),
      ]);
      setUsers(usersRes.users);
      setAudit(auditRes.events);
      setProviders(providersRes.providers);
    } catch {
      /* la porte renvoie 403 pour un non-Admin : l'onglet est masqué */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Applique un profil : pré-coche providers + modèles correspondants. */
  const applyProfile = useCallback(
    (next: TaskProfile) => {
      setProfile(next);
      const patterns = PROFILE_MODEL_PATTERNS[next];
      if (patterns === 'all') {
        setCheckedProviders(providers.map((p) => p.id));
        setCheckedModels(providers.flatMap((p) => p.models));
        return;
      }
      if (patterns === 'none') {
        setCheckedProviders([]);
        setCheckedModels([]);
        return;
      }
      const lower = patterns.map((p) => p.toLowerCase());
      const matches = (id: string) =>
        lower.some((pattern) => id.toLowerCase().includes(pattern));
      const matchedProviders = providers.filter((p) =>
        p.models.some((model) => matches(model)),
      );
      setCheckedProviders(matchedProviders.map((p) => p.id));
      setCheckedModels(
        matchedProviders.flatMap((p) => p.models.filter((m) => matches(m))),
      );
    },
    [providers],
  );

  const openCreate = () => {
    setEditing(null);
    setUsername('');
    setPassword('');
    setRole('user');
    setMonthlyLimit('');
    setMaxDots('');
    setNewPassword('');
    setError('');
    setSaved('');
    setProfile('polyvalent');
    setCheckedProviders(providers.map((p) => p.id));
    setCheckedModels(providers.flatMap((p) => p.models));
    setView('form');
  };
  const openEdit = (user: AccountUser) => {
    setEditing(user);
    setUsername(user.username);
    setPassword('');
    setRole(user.role);
    setMonthlyLimit(
      user.monthlyLimitUsd == null ? '' : String(user.monthlyLimitUsd),
    );
    setMaxDots(user.maxDots == null ? '' : String(user.maxDots));
    setNewPassword('');
    setError('');
    setSaved('');
    setProfile('personnalise');
    setCheckedProviders(user.allowedProviders ?? []);
    setCheckedModels(user.allowedModels ?? []);
    setView('form');
  };

  const toggleProvider = (id: string) => {
    setCheckedProviders((prev) => {
      const next = prev.includes(id)
        ? prev.filter((p) => p !== id)
        : [...prev, id];
      // Décocher un provider décoche ses modèles (filtrés par providers).
      if (!next.includes(id)) {
        const modelsOf = providers.find((p) => p.id === id)?.models ?? [];
        setCheckedModels((models) =>
          models.filter((m) => !modelsOf.includes(m)),
        );
      }
      return next;
    });
  };
  const toggleModel = (id: string) =>
    setCheckedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );

  const parseLimit = (raw: string): number | null => {
    const value = raw.trim();
    if (!value) return null;
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : NaN;
  };
  const parseMaxDots = (raw: string): number | null => {
    const value = raw.trim();
    if (!value) return null;
    const num = Number(value);
    return Number.isInteger(num) && num >= 1 ? num : NaN;
  };

  const submit = async () => {
    setError('');
    setSaved('');
    if (!editing && username.trim().length < 1) {
      setError('Entrez un nom d’utilisateur.');
      return;
    }
    if (!editing && password.length < 12) {
      setError('Le mot de passe doit faire au moins 12 caractères.');
      return;
    }
    const monthlyLimitUsd = parseLimit(monthlyLimit);
    const maxDotsValue = parseMaxDots(maxDots);
    if (Number.isNaN(monthlyLimitUsd)) {
      setError('La limite mensuelle doit être un nombre ≥ 0 (ou vide).');
      return;
    }
    if (Number.isNaN(maxDotsValue)) {
      setError('Le nombre max de Dots doit être un entier ≥ 1 (ou vide).');
      return;
    }
    if (
      role === 'user' &&
      (checkedProviders.length === 0 || checkedModels.length === 0)
    ) {
      setError('Sélectionnez au moins un provider et un modèle.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        ...(editing ? {} : { username: username.trim(), password }),
        ...(editing ? { role } : { role }),
        allowedProviders: role === 'admin' ? undefined : checkedProviders,
        allowedModels: role === 'admin' ? undefined : checkedModels,
        monthlyLimitUsd,
        maxDots: maxDotsValue,
      };
      if (editing) {
        await api<{ ok: boolean }>(`/auth/users/${editing.id}`, 'PATCH', body);
      } else {
        await api<{ ok: boolean }>('/auth/users', 'POST', body);
      }
      setSaved('Compte enregistré.');
      setView('list');
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save the account.',
      );
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (!editing) return;
    setError('');
    setSaved('');
    if (newPassword.length < 12) {
      setError('Le nouveau mot de passe doit faire au moins 12 caractères.');
      return;
    }
    setBusy(true);
    try {
      await api<{ ok: boolean }>(`/auth/users/${editing.id}/password`, 'POST', {
        password: newPassword,
      });
      setSaved('Mot de passe changé (sessions de ce compte révoquées).');
      setNewPassword('');
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not change the password.',
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setError('');
    setSaved('');
    if (!masterPassword) {
      setError('Entrez le mot de passe maître.');
      return;
    }
    setBusy(true);
    try {
      await api<{ ok: boolean }>(`/auth/users/${deleting.id}`, 'DELETE', {
        masterPassword,
        confirm: true,
      });
      setSaved('Compte supprimé (données effacées).');
      setDeleting(null);
      setMasterPassword('');
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not delete the account.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Modèles affichés : ceux des providers cochés.
  const visibleModels = providers
    .filter((p) => checkedProviders.includes(p.id))
    .flatMap((p) => p.models.map((model) => ({ provider: p, model })));

  return (
    <div className="prefs-section">
      <h3 className="prefs-section-title">Comptes</h3>
      <p className="muted">
        Seul un Admin voit cet onglet. La suppression d’un compte efface toutes
        ses données (irréversible).
      </p>
      {error && <p className="chat-error">{error}</p>}
      {saved && <p className="muted">{saved}</p>}
      {view === 'list' && (
        <>
          <button type="button" className="primary" onClick={openCreate}>
            Créer un compte
          </button>
          <div className="dot-model-list">
            {users.map((user) => (
              <div className="dot-model-row" key={user.id}>
                <span className="dot-model-name">
                  {user.username}
                  <span className="dot-model-meta">
                    {user.role === 'admin' ? 'Admin' : 'Utilisateur'}
                    {user.role === 'user' &&
                      ` · ${user.allowedProviders?.length ?? 0} providers · ${user.allowedModels?.length ?? 0} modèles`}
                    {user.maxDots != null && ` · max ${user.maxDots} Dots`}
                    {user.monthlyLimitUsd != null &&
                      ` · limite ${user.monthlyLimitUsd} $/mois`}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => openEdit(user)}
                >
                  Modifier
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setDeleting(user);
                    setError('');
                    setSaved('');
                  }}
                >
                  Supprimer
                </button>
              </div>
            ))}
            {users.length === 0 && (
              <p className="muted">Aucun compte (hors le vôtre).</p>
            )}
          </div>
          {deleting && (
            <fieldset className="prefs-section">
              <legend>
                Supprimer « {deleting.username} » ? Irréversible : toutes ses
                données seront effacées.
              </legend>
              <label className="prefs-field">
                <span className="prefs-field-label">Mot de passe maître</span>
                <input
                  type="password"
                  value={masterPassword}
                  onChange={(e) => setMasterPassword(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                Supprimer définitivement
              </button>{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setDeleting(null);
                  setMasterPassword('');
                }}
              >
                Annuler
              </button>
            </fieldset>
          )}
          <h4 className="prefs-section-title">Journal d’audit</h4>
          <div className="dot-model-list">
            {audit.map((event) => (
              <div className="dot-model-row" key={event.id}>
                <span className="dot-model-name">
                  {AUDIT_LABELS[event.action] ?? event.action}
                  <span className="dot-model-meta">
                    {event.username} · {event.ip} · {fmtDate(event.at)}
                  </span>
                </span>
              </div>
            ))}
            {audit.length === 0 && <p className="muted">Aucun événement.</p>}
          </div>
        </>
      )}
      {view === 'form' && (
        <fieldset className="prefs-section">
          <legend>{editing ? 'Modifier le compte' : 'Créer un compte'}</legend>
          {!editing && (
            <label className="prefs-field">
              <span className="prefs-field-label">Nom d’utilisateur</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          {!editing && (
            <label className="prefs-field">
              <span className="prefs-field-label">
                Mot de passe (12 caractères min.)
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}
          <label className="prefs-field">
            <span className="prefs-field-label">Rôle</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
            >
              <option value="user">Utilisateur</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          {role === 'user' && (
            <>
              <label className="prefs-field">
                <span className="prefs-field-label">
                  Profil de tâches (pré-coche providers / modèles)
                </span>
                <select
                  value={profile}
                  onChange={(e) => applyProfile(e.target.value as TaskProfile)}
                >
                  {(Object.keys(PROFILE_LABELS) as TaskProfile[]).map((key) => (
                    <option value={key} key={key}>
                      {PROFILE_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="prefs-field">
                <span className="prefs-field-label">Providers autorisés</span>
                <div className="dot-model-list">
                  {providers.map((provider) => (
                    <label className="dot-model-row" key={provider.id}>
                      <input
                        type="checkbox"
                        checked={checkedProviders.includes(provider.id)}
                        onChange={() => toggleProvider(provider.id)}
                      />
                      <span className="dot-model-name">{provider.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="prefs-field">
                <span className="prefs-field-label">
                  Modèles autorisés (des providers cochés)
                </span>
                <div className="dot-model-list">
                  {visibleModels.map(({ provider, model }) => (
                    <label
                      className="dot-model-row"
                      key={`${provider.id}:${model}`}
                    >
                      <input
                        type="checkbox"
                        checked={checkedModels.includes(model)}
                        onChange={() => toggleModel(model)}
                      />
                      <span className="dot-model-name">
                        {model}
                        <span className="dot-model-meta">{provider.label}</span>
                      </span>
                    </label>
                  ))}
                  {visibleModels.length === 0 && (
                    <p className="muted">
                      Cochez d’abord un provider pour voir ses modèles.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
          <label className="prefs-field">
            <span className="prefs-field-label">
              Limite de consommation mensuelle (en $, vide = illimitée)
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
              placeholder="Ex. 20"
            />
          </label>
          <label className="prefs-field">
            <span className="prefs-field-label">
              Nombre max de Dots (vide = illimité)
            </span>
            <input
              type="number"
              min="1"
              step="1"
              value={maxDots}
              onChange={(e) => setMaxDots(e.target.value)}
              placeholder="Ex. 5"
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {editing ? 'Enregistrer' : 'Créer le compte'}
          </button>{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => setView('list')}
          >
            Annuler
          </button>
          {editing && (
            <fieldset className="prefs-section">
              <legend>Changer le mot de passe de ce compte</legend>
              <label className="prefs-field">
                <span className="prefs-field-label">
                  Nouveau mot de passe (12 caractères min.)
                </span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void changePassword()}
              >
                Changer le mot de passe
              </button>
              <p className="muted">
                Les sessions de ce compte seront révoquées.
              </p>
            </fieldset>
          )}
        </fieldset>
      )}
    </div>
  );
}
