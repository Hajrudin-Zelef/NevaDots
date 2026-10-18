/**
 * Lot 5.1 (#6, option a) : l'auth par token est exigée par défaut.
 * Seul `REQUIRE_OWNER_TOKEN=false` explicite la désactive (dev local).
 * Toute autre valeur (absente, 'true', 'yes', '', …) = exigée.
 * Le `env` en paramètre rend la décision testable sans toucher à
 * `process.env` ; `index.ts` appelle sans argument (process.env).
 */
export function requireOwnerToken(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.REQUIRE_OWNER_TOKEN !== 'false';
}
