/**
 * Turns opaque model/transport failures into short, actionable messages shown
 * in the chat. Covers the real-world cases behind "the turn returned no
 * response": an unfunded provider, a bad key, a missing model, a rate limit,
 * an oversized context, a timeout, or a dropped connection.
 */
export const EMPTY_RESPONSE_MESSAGE =
  'Le modèle n’a produit aucune réponse. Réessaie, ou choisis un autre modèle dans le sélecteur.';

export function classifyModelError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error
          ? JSON.stringify(error)
          : '';
  const text = raw.toLowerCase();
  if (
    /\b402\b|\b403\b|insufficient|quota|credit|balance|billing|payment|not enough|exceeded your current quota/.test(
      text,
    )
  )
    return 'Ce modèle n’a pas de crédit disponible chez son fournisseur. Choisis un modèle OpenCode dans le sélecteur, ou recharge le compte du fournisseur.';
  if (/\b401\b|invalid api key|incorrect api key|unauthorized/.test(text))
    return 'La clé d’API du modèle est invalide ou expirée. Vérifie la configuration du serveur.';
  if (
    /\b404\b|model not found|does not exist|unknown model|no such model/.test(
      text,
    )
  )
    return 'Modèle introuvable chez le fournisseur. Choisis un autre modèle dans le sélecteur.';
  if (/\b429\b|rate limit|too many requests/.test(text))
    return 'Le fournisseur a limité le débit (trop de requêtes). Patiente quelques secondes et réessaie.';
  if (
    /context length|too many tokens|maximum context|context_length_exceeded/.test(
      text,
    )
  )
    return 'La conversation dépasse la fenêtre de contexte du modèle. Elle sera compressée automatiquement ; réessaie.';
  if (/timeout|timed out|etimedout|aborted/.test(text))
    return 'Le modèle n’a pas répondu à temps. Réessaie, ou choisis un modèle plus rapide.';
  if (
    /econnrefused|enotfound|fetch failed|eai_again|socket hang up|network/.test(
      text,
    )
  )
    return 'Impossible de joindre le fournisseur du modèle. Vérifie la connexion du serveur et réessaie.';
  if (/econnreset|premature close|stream|terminated/.test(text))
    return 'La connexion au modèle a été coupée en cours de réponse. Réessaie.';
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  return snippet
    ? `Le modèle a échoué : ${snippet}`
    : 'Le modèle a échoué sans message. Réessaie ou choisis un autre modèle.';
}
