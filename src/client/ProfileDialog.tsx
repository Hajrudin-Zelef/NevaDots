import { useEffect } from 'react';
import { X } from 'lucide-react';
import { refreshSessionStatus, useSessionStatus } from './session-model';

/**
 * Phase F (menu avatar → Profil) : la fiche du compte connecté — nom,
 * rôle, et (compte restreint) ses limites. Lecture seule : le changement
 * de mot de passe passe par le code de réinitialisation de l'Admin.
 */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  // MVC-Statut (lot 1.4) : identité + profil lus dans le modèle, jamais de
  // fetch local. App boot le modèle ; ici on revalide si le profil manque.
  const session = useSessionStatus();
  useEffect(() => {
    if (session.state === 'in' && !session.profile) void refreshSessionStatus();
  }, [session.state, session.profile]);
  const username = session.username;
  const role = session.role;
  const profile = session.profile;
  const restricted = username !== null && role !== 'admin';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Fermer"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <span className="eyebrow">NEVADOTS</span>
        <h2 id="dialog-title">Profil</h2>
        {!username && <p className="muted">Chargement…</p>}
        {username && (
          <div className="prefs-section">
            <div className="prefs-field">
              <span className="prefs-field-label">Nom d'utilisateur</span>
              <span>{username}</span>
            </div>
            <div className="prefs-field">
              <span className="prefs-field-label">Rôle</span>
              <span>{role === 'admin' ? 'Admin' : 'Utilisateur'}</span>
            </div>
            {restricted && (
              <>
                <div className="prefs-field">
                  <span className="prefs-field-label">Nombre max de Dots</span>
                  <span>
                    {!profile || profile.maxDots === null
                      ? 'Sans limite'
                      : profile.maxDots}
                  </span>
                </div>
                <div className="prefs-field">
                  <span className="prefs-field-label">
                    Limite mensuelle (modèles)
                  </span>
                  <span>
                    {!profile || profile.monthlyLimitUsd === null
                      ? 'Sans limite'
                      : `${profile.monthlyLimitUsd} $`}
                  </span>
                </div>
                <div className="prefs-field">
                  <span className="prefs-field-label">Providers autorisés</span>
                  <span>
                    {!profile || profile.allowedProviders === null
                      ? 'Sans restriction'
                      : profile.allowedProviders.join(', ')}
                  </span>
                </div>
                <div className="prefs-field">
                  <span className="prefs-field-label">Modèles autorisés</span>
                  <span>
                    {!profile || profile.allowedModels === null
                      ? 'Sans restriction'
                      : profile.allowedModels.join(', ')}
                  </span>
                </div>
              </>
            )}
            {role === 'admin' && (
              <p className="muted">
                Compte Admin : sans restriction (tous les providers, tous les
                modèles, pas de limite).
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
