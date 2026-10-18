/** Le jeton propriétaire n'est jamais stocké dans le JS : il vit dans
 *  un cookie HttpOnly posé par POST /api/login (cf. serveur). Le client
 *  ne connaît que l'état « authentifié » (drapeau local, pas le jeton).
 *  Toutes les requêtes envoient le cookie (credentials: 'include') :
 *  <img> et liens de téléchargement inclus, sans en-tête Authorization. */
let authed = false;
/** Whether this tab has opened an authenticated session. */
export function isAuthed(): boolean {
  return authed;
}
function setAuthed(value: boolean) {
  authed = value;
}
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
/** Ouvre une session : vérifie le jeton côté serveur et pose le cookie HttpOnly. */
export async function login(token: string): Promise<void> {
  await api('/login', 'POST', { token });
  setAuthed(true);
}
/** Ferme la session : efface le cookie HttpOnly côté serveur. */
export async function logout(): Promise<void> {
  await api('/logout', 'POST');
  setAuthed(false);
}
