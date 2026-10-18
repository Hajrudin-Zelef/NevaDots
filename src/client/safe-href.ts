/**
 * Liens sûrs pour le rendu : le contenu Markdown vient du modèle, il ne
 * doit jamais produire un lien exécutable ou trompeur. Seuls passent :
 * - les liens internes vers les Spaces (`/#/spaces/...`, gérés par
 *   l'application, jamais un nouvel onglet) ;
 * - les schémas `http:`, `https:` et `mailto:`.
 * Tout le reste (javascript:, data:, vbscript:, malformé, relatif, …)
 * est neutralisé : le texte reste affiché, sans lien cliquable.
 * La CSP bloque déjà `javascript:` en pratique ; ceci est la défense
 * en profondeur côté rendu (et couvre `data:text/html`, que la CSP
 * ne bloque pas).
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Href nettoyé, ou null si le lien doit être neutralisé. */
export function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('/#/spaces/')) return href;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  return href;
}

/** Hostname d'une URL, ou null si malformée (ne jette jamais). */
export function safeHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Hôte d'une URL (avec port), ou null si malformée (ne jette jamais). */
export function safeHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
