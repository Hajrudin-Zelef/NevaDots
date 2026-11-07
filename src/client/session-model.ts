import { useSyncExternalStore } from 'react';
import { ApiError, api } from './api.js';

/** Phase MVC-Statut (lot 1.1) : le statut de session est détenu par ce seul
 *  modèle. Les vues s'abonnent (miroirs passifs), les contrôleurs appellent
 *  refresh/logout (déclencheurs sans état). Le client reste un miroir du
 *  serveur : `in` exige une réponse `/me` valide, jamais un `true` local. */

export type SessionState = 'unknown' | 'in' | 'out';

export interface SessionStatus {
  state: SessionState;
  username: string | null;
  role: 'admin' | 'user' | null;
}

interface MeResponse {
  username?: unknown;
  role?: unknown;
}

const UNKNOWN: SessionStatus = { state: 'unknown', username: null, role: null };
const OUT: SessionStatus = { state: 'out', username: null, role: null };

let status: SessionStatus = { ...UNKNOWN };
const listeners = new Set<() => void>();
/** Requête `/me` en cours, partagée : un seul GET même à N abonnés. */
let inflight: Promise<SessionStatus> | null = null;

function setStatus(next: SessionStatus): void {
  status = next;
  for (const notify of listeners) notify();
}

/** Lecture du statut (rendu + tests). */
export function getSessionStatus(): SessionStatus {
  return status;
}

/** Abonnement des vues (via `useSessionStatus` de préférence). */
export function subscribeSessionStatus(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Miroir React du statut (re-rendu à chaque notification du modèle). */
export function useSessionStatus(): SessionStatus {
  return useSyncExternalStore(
    subscribeSessionStatus,
    getSessionStatus,
    getSessionStatus,
  );
}

/** Revalide le statut depuis le serveur. 401 → `out`. Toute autre erreur
 *  (réseau, 503) conserve le statut précédent : pas de verdict mensonger. */
export async function refreshSessionStatus(): Promise<SessionStatus> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const me = await api<MeResponse>('/auth/me');
      const username = typeof me.username === 'string' ? me.username : null;
      const role = me.role === 'admin' || me.role === 'user' ? me.role : null;
      setStatus(username ? { state: 'in', username, role } : { ...OUT });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        setStatus({ ...OUT });
    } finally {
      inflight = null;
    }
    return status;
  })();
  return inflight;
}

/** Ferme la session côté serveur puis passe à `out`. La navigation vers
 *  `/login` reste du ressort de l'appelant (contrôleur/vue). */
export async function logoutSession(): Promise<void> {
  try {
    await api('/auth/logout', 'POST');
  } finally {
    setStatus({ ...OUT });
  }
}

/** Réservé aux tests : réinitialise le modèle entre deux cas. */
export function resetSessionModelForTests(): void {
  status = { ...UNKNOWN };
  inflight = null;
  listeners.clear();
}
