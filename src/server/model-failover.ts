/**
 * Bascule à chaud de modèle.
 *
 * Un tour d'agent est lancé avec le modèle du Dot au moment du départ. Si
 * l'utilisateur change de modèle pendant ce tour — typiquement parce que le
 * modèle courant renvoie une erreur API — la requête chat-completions doit
 * suivre : on la réécrit vers le modèle courant du Dot, puis on la rejoue
 * une fois. La conversation, elle, ne bouge pas : le nouveau modèle reçoit
 * le même historique, comme s'il avait été là depuis le début.
 *
 * Ce module est volontairement pur (aucun accès réseau ni état global) :
 * `dot-agent.ts` décide *quand* basculer, ces fonctions disent *comment*.
 */

export interface ChatTarget {
  providerId: string | null;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** Deux cibles identiques : inutile de réécrire la requête. */
export function sameChatTarget(a: ChatTarget, b: ChatTarget): boolean {
  return (
    a.model === b.model &&
    a.baseUrl === b.baseUrl &&
    a.apiKey === b.apiKey &&
    a.providerId === b.providerId
  );
}

/**
 * Statuts qui justifient de rejouer la requête sur le modèle courant.
 * Couvre les vraies causes d'échec d'un provider : clé morte, quota,
 * modèle retiré, débit limité, panne, requête refusée (contexte trop
 * grand pour ce modèle). Un 200 ou une annulation n'y figurent jamais.
 */
export function shouldFailover(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 422 ||
    status === 429 ||
    status >= 500
  );
}

function joinCompletions(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '').concat('/chat/completions');
}

/**
 * Réécrit une requête chat-completions vers `target` : URL du provider,
 * en-tête d'autorisation et champ `model` du corps JSON. Retourne `null`
 * quand la requête n'est pas réécrivable (corps non-JSON, flux, …) — dans
 * ce cas l'appelant garde la requête d'origine.
 */
export function retargetChatCompletions(
  init: RequestInit | undefined,
  target: ChatTarget,
): { url: string; init: RequestInit } | null {
  if (!init || typeof init.body !== 'string' || !init.body.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const body = { ...(parsed as Record<string, unknown>), model: target.model };
  const headers = new Headers(init.headers ?? undefined);
  headers.set('content-type', 'application/json');
  if (target.apiKey) headers.set('authorization', `Bearer ${target.apiKey}`);
  return {
    url: joinCompletions(target.baseUrl),
    init: { ...init, headers, body: JSON.stringify(body) },
  };
}
