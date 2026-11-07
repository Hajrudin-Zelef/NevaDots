import { useSyncExternalStore } from 'react';
import { ApiError } from './api-error.js';

/** Transport vers le serveur, injectable en tests. Le défaut passe par
 *  `api.ts` (import différé : `api.ts` importe déjà ce modèle pour le 401,
 *  un import statique bouclerait). */
export interface SessionTransport {
  getMe(): Promise<MeResponse>;
  postLogout(): Promise<unknown>;
}

async function defaultTransport(): Promise<SessionTransport> {
  const { api } = await import('./api.js');
  return {
    getMe: () => api<MeResponse>('/auth/me'),
    postLogout: () => api('/auth/logout', 'POST'),
  };
}

/** Phase MVC-Statut (lot 1.1) : le statut de session est détenu par ce seul
 *  modèle. Les vues s'abonnent (miroirs passifs), les contrôleurs appellent
 *  refresh/logout (déclencheurs sans état). Le client reste un miroir du
 *  serveur : `in` exige une réponse `/me` valide, jamais un `true` local. */

export type SessionState = 'unknown' | 'in' | 'out';

export interface SessionStatus {
  state: SessionState;
  username: string | null;
  role: 'admin' | 'user' | null;
  /** Limites du compte (Profil, onglets) — remplies par le même `/me`. */
  profile: SessionProfile | null;
}

export interface SessionProfile {
  maxDots: number | null;
  monthlyLimitUsd: number | null;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
}

interface MeResponse {
  username?: unknown;
  role?: unknown;
  maxDots?: unknown;
  monthlyLimitUsd?: unknown;
  allowedProviders?: unknown;
  allowedModels?: unknown;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toStringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;
}

const UNKNOWN: SessionStatus = {
  state: 'unknown',
  username: null,
  role: null,
  profile: null,
};
const OUT: SessionStatus = {
  state: 'out',
  username: null,
  role: null,
  profile: null,
};

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
export async function refreshSessionStatus(
  transport?: SessionTransport,
): Promise<SessionStatus> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const t = transport ?? (await defaultTransport());
      const me = await t.getMe();
      const username = typeof me.username === 'string' ? me.username : null;
      const role = me.role === 'admin' || me.role === 'user' ? me.role : null;
      setStatus(
        username
          ? {
              state: 'in',
              username,
              role,
              profile: {
                maxDots: toNumberOrNull(me.maxDots),
                monthlyLimitUsd: toNumberOrNull(me.monthlyLimitUsd),
                allowedProviders: toStringArrayOrNull(me.allowedProviders),
                allowedModels: toStringArrayOrNull(me.allowedModels),
              },
            }
          : { ...OUT },
      );
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
export async function logoutSession(
  transport?: SessionTransport,
): Promise<void> {
  try {
    const t = transport ?? (await defaultTransport());
    await t.postLogout();
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
