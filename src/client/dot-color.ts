/**
 * Couleur d'avatar par Dot (Lot 2 du portage visuel OpenCode) : l'avatar
 * 16 px de chaque ligne de session est l'initiale du Dot sur un fond dont
 * la teinte est dérivée de l'id du Dot — stable d'un rendu à l'autre, sans
 * table de correspondance à maintenir.
 */

function hashString(value: string): number {
  // FNV-1a 32 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Teinte HSL (0–359) stable pour un id de Dot. */
export function dotHue(dotId: string): number {
  return hashString(dotId) % 360;
}

/** Style inline de l'avatar 16 px : fond teinté par Dot, texte blanc. */
export function dotAvatarStyle(dotId: string): {
  backgroundColor: string;
  color: string;
} {
  return {
    backgroundColor: `hsl(${dotHue(dotId)} 45% 42%)`,
    color: '#ffffff',
  };
}
