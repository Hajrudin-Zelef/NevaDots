/**
 * Détection du type réel d'un fichier par ses magic bytes (signature en
 * début de fichier). Ne croit jamais le type déclaré par le client : un
 * navigateur déclare le type d'après l'extension, qui peut mentir.
 *
 * Seuls les types qui reçoivent un traitement spécial sont vérifiés :
 * les images binaires et les PDF (aperçu image/PDF, outils PDF). Le SVG
 * est textuel (pas de signature binaire) : il reste tel quel.
 */

/** Signatures préfixe : type -> premiers octets. */
const SIGNATURES: ReadonlyArray<{ mime: string; prefix: readonly number[] }> = [
  { mime: 'application/pdf', prefix: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  {
    mime: 'image/png',
    prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
];

/** Type détecté par la signature, ou null si aucune signature connue. */
export function sniffMime(buffer: Uint8Array): string | null {
  for (const { mime, prefix } of SIGNATURES) {
    if (
      buffer.length >= prefix.length &&
      prefix.every((byte, index) => buffer[index] === byte)
    )
      return mime;
  }
  // WebP : RIFF + taille (4 octets) + WEBP.
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  )
    return 'image/webp';
  return null;
}

/** Alias courants vers leur type canonique (évite les faux rejets). */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
};

/**
 * Résout le type d'un fichier uploadé à partir de ses octets.
 * - Type déclaré image (hors SVG) ou PDF (déclaré, ou via l'extension
 *   .pdf qui force aussi la catégorie pdf) : les octets doivent
 *   correspondre, sinon le fichier est dégradé en octet-stream
 *   (ok = false) — jamais rejeté, jamais monté.
 * - Autres types (texte, octet-stream sans extension .pdf, ...) :
 *   inchangés, sans vérification.
 */
export function resolveUploadType(
  buffer: Uint8Array,
  declared: string,
  name: string,
): { mime: string; ok: boolean } {
  if (declared === 'image/svg+xml') return { mime: declared, ok: true };
  const normalized = MIME_ALIASES[declared] ?? declared;
  let expected: string | null = null;
  if (normalized.startsWith('image/')) expected = normalized;
  else if (
    normalized === 'application/pdf' ||
    name.toLowerCase().endsWith('.pdf')
  )
    expected = 'application/pdf';
  if (expected === null) return { mime: declared, ok: true };
  if (sniffMime(buffer) === expected) return { mime: normalized, ok: true };
  return { mime: 'application/octet-stream', ok: false };
}
