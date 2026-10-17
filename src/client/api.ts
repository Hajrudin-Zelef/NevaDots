let token = sessionStorage.getItem('opendots-token') ?? '';
// The owner token is also mirrored into a SameSite=Strict cookie scoped to
// /dots (avatar <img>) and /api/attachments (raw download links and image
// thumbnails, which cannot carry an Authorization header). The server gates
// both on it.
function syncAuthCookie() {
  if (typeof document === 'undefined') return;
  const secure =
    typeof location !== 'undefined' && location.protocol === 'https:'
      ? '; Secure'
      : '';
  for (const path of ['/dots', '/api/attachments']) {
    document.cookie = token
      ? `opendots-auth=${encodeURIComponent(token)}; path=${path}; SameSite=Strict${secure}`
      : `opendots-auth=; path=${path}; Max-Age=0; SameSite=Strict`;
  }
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
/** Whether an owner token is stored (the raw token is never exported). */
export function hasToken(): boolean {
  return token.length > 0;
}
