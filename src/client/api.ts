let token = sessionStorage.getItem('opendots-token') ?? '';
// The owner token is also mirrored into a SameSite=Strict cookie scoped to
// /dots, so the browser attaches it to avatar <img> requests (which cannot
// carry an Authorization header). The server gates /dots on it.
function syncAuthCookie() {
  if (typeof document === 'undefined') return;
  const secure =
    typeof location !== 'undefined' && location.protocol === 'https:'
      ? '; Secure'
      : '';
  document.cookie = token
    ? `opendots-auth=${encodeURIComponent(token)}; path=/dots; SameSite=Strict${secure}`
    : 'opendots-auth=; path=/dots; Max-Age=0; SameSite=Strict';
}
syncAuthCookie();
export function setToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem('opendots-token', value);
  else sessionStorage.removeItem('opendots-token');
  syncAuthCookie();
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
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
/** Raw owner token, for the WebSocket URL (browsers cannot set WS headers). */
export function authToken(): string {
  return token;
}
