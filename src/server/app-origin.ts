export function resolveAppOrigins(
  appOrigin: string | undefined,
  nodeEnv: string | undefined,
): string[] | undefined {
  if (appOrigin)
    return appOrigin
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  return nodeEnv === 'development'
    ? ['http://localhost:5173', 'http://127.0.0.1:5173']
    : undefined;
}

/**
 * Referer autorisé pour les avatars (/dots/*) : son origine doit être une
 * origine configurée (APP_ORIGIN) ou l'origine de la requête (accès direct
 * local / dev). Avant ce correctif, le Referer était comparé à l'URL locale
 * du serveur (http://127.0.0.1:4310) : derrière le proxy, tout navigateur
 * envoyait Referer: https://nevadots.neva-ci.pro/... → 403 systématique.
 */
export function avatarRefererAllowed(
  referer: string,
  configuredOrigins: string[],
  requestOrigin: string,
): boolean {
  try {
    return new Set([...configuredOrigins, requestOrigin]).has(
      new URL(referer).origin,
    );
  } catch {
    return false;
  }
}
