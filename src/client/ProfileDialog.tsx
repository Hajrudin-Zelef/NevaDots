import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';

interface MeResponse {
  username: string;
  role: string;
  maxDots: number | null;
  monthlyLimitUsd: number | null;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
}

/**
 * Phase F (menu avatar → Profil) : la fiche du compte connecté — nom,
 * rôle, et (compte restreint) ses limites. Lecture seule : le changement
 * de mot de passe passe par le code de réinitialisation de l'Admin.
 */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<MeResponse>('/auth/me')
      .then((value) => {
        if (active) setMe(value);
      })
      .catch(() => {
        if (active) setError('Impossible de charger ton profil.');
      });
    return () => {
      active = false;
    };
  }, []);
  const restricted = me !== null && me.role !== 'admin';
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
          <X size={18} />
        </button>
        <span className="eyebrow">NEVADOTS</span>
        <h2 id="dialog-title">Profil</h2>
        {error && <p className="chat-error">{error}</p>}
        {!me && !error && <p className="muted">Chargement…</p>}
        {me && (
          <div className="prefs-section">
            <div className="prefs-field">
              <span className="prefs-field-label">Nom d'utilisateur</span>
              <span>{me.username}</span>
            </div>
            <div className="prefs-field">
              <span className="prefs-field-label">Rôle</span>
              <span>{me.role === 'admin' ? 'Admin' : 'Utilisateur'}</span>
            </div>
            {restricted && (
              <>
                <div className="prefs-field">
                  <span className="prefs-field-label">Nombre max de Dots</span>
                  <span>
                    {me.maxDots === null ? 'Sans limite' : me.maxDots}
                  </span>
                </div>
                <div className="prefs-field">
                  <span className="prefs-field-label">
                    Limite mensuelle (modèles)
                  </span>
                  <span>
                    {me.monthlyLimitUsd === null
                      ? 'Sans limite'
                      : `${me.monthlyLimitUsd} $`}
                  </span>
                </div>
                <div className="prefs-field">
                  <span className="prefs-field-label">Providers autorisés</span>
                  <span>
                    {me.allowedProviders === null
                      ? 'Sans restriction'
                      : me.allowedProviders.join(', ')}
                  </span>
                </div>
                <div className="prefs-field">
                  <span className="prefs-field-label">Modèles autorisés</span>
                  <span>
                    {me.allowedModels === null
                      ? 'Sans restriction'
                      : me.allowedModels.join(', ')}
                  </span>
                </div>
              </>
            )}
            {!restricted && (
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
