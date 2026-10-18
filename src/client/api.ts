/** Phase B (comptes) : le client ne connaît ni mot de passe ni jeton.
 *  La page /login (servie par le serveur) gère la connexion ; le client
 *  envoie le cookie de session HttpOnly (credentials: 'include') et
 *  redirige vers /login dès qu'une API répond 401 (session expirée ou
 *  révoquée). La SPA ne se charge que si la session est valide (porte
 *  serveur), donc aucune page de connexion dans le client. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: {
      ...(['GET', 'HEAD'].includes(method)
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 && typeof window !== 'undefined')
    window.location.href = '/login';
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}
/** Ferme la session (suppression côté serveur) puis retourne à /login. */
export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', 'POST');
  } finally {
    if (typeof window !== 'undefined') window.location.href = '/login';
  }
}
