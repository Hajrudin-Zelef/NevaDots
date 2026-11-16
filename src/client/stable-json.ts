/**
 * Comparaison structurelle bon marché pour les réponses de polling.
 *
 * Le client interroge `/state` et `/workspace` en continu : la réponse est
 * presque toujours identique. Remplacer l'état par un objet équivalent
 * déclenche un re-render complet de l'app (et du chat) toutes les 3 s, pour
 * rien. On ne remplace donc l'état que si le contenu a réellement changé.
 *
 * `JSON.stringify` suffit ici : les payloads viennent du serveur, avec un
 * ordre de clés stable (même sérialiseur), et ils font quelques kilo-octets.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
