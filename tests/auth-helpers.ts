import type { AuthStore } from '../src/server/auth-store.js';

/** Phase B (comptes) : helper commun — crée l'utilisateur (si absent),
 *  se connecte via POST /api/auth/login et renvoie la valeur du Cookie
 *  de session à passer dans les requêtes (`{ headers: { Cookie } }`).
 *  Remplace l'ancien `createApp({ ownerToken })` + en-tête Bearer. */
export async function loginSession(
  app: {
    request: (url: string, init?: RequestInit) => Response | Promise<Response>;
  },
  auth: AuthStore,
  username = 'marie',
  password = 'a-strong-password',
): Promise<string> {
  if (!auth.getUserByUsername(username))
    await auth.createUser(username, password, 'user');
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200)
    throw new Error(`loginSession failed for ${username}: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith('nevadots-session='));
  if (!cookie) throw new Error('loginSession: no session cookie');
  return cookie.split(';')[0];
}

/** Session sans passer par HTTP (pas de requête, pas de bucket rate-limit
 *  consommé) : pour les tests qui vérifient le rate-limit lui-même. */
export async function directSession(
  auth: AuthStore,
  username = 'marie',
  password = 'a-strong-password',
): Promise<string> {
  const existing = auth.getUserByUsername(username);
  const user = existing ?? (await auth.createUser(username, password, 'user'));
  const { rawId } = auth.createSession(user.id);
  return `nevadots-session=${rawId}`;
}
