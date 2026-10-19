/**
 * Phase F : initiales du compte pour l'avatar rond de la barre latérale.
 * « marie » → « MA », « hajrudin-zelef » → « HZ », « a » → « A ».
 */
export function initialsOf(username: string): string {
  const parts = username.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const two = username.slice(0, 2).toUpperCase();
  return two || '•';
}
