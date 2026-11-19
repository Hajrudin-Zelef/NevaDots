/**
 * Capture déterministe de la mémoire explicite.
 *
 * Aucun modèle, aucune inférence : on ne retient que ce que l'utilisateur dit
 * explicitement de retenir (« retiens que… », « remember that… »). Le texte est
 * stocké tel quel, avec sa provenance ; l'utilisateur peut l'éditer ou le
 * supprimer dans Réglages → Mémoire.
 */

/** Plafond de mémoires par compte (aucune éviction silencieuse). */
export const MEMORY_LIMIT = 200;
/** Longueur maximale d'une mémoire (le prompt est déjà borné à 2000 car.). */
export const MEMORY_MAX_CHARS = 500;
/** Longueur minimale : en dessous, ce n'est pas un fait exploitable. */
const MEMORY_MIN_CHARS = 8;

/**
 * Déclencheur en début de proposition ou après une ponctuation. Le groupe
 * optionnel absorbe « que / qu' / ça / that » pour ne garder que le fait.
 */
const TRIGGER =
  /(?:^|[\s,;:!?])(?:retiens|m[ée]morise|souviens[\s-]toi|rappelle[\s-]toi|note bien|garde en m[ée]moire|remember)(?:\s+(?:que|qu['’]|ça|ca|ceci|ce qui suit|that))?/i;

/** Motifs de secrets : on refuse la capture plutôt que de stocker une clé. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/i,
  /\b(?:ghp|gho|ghs|ws|oc_sk)_[A-Za-z0-9_-]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /-----BEGIN [A-Z ]+-----/,
  /\b(?:password|passwd|mot de passe|api[\s_-]?key|token|secret)\b\s*(?:[:=]|est|is)\s/i,
  /\b(?:\d[ -]?){12,18}\d\b/,
];

/**
 * Extrait le fait à retenir, ou `null` si le message ne demande rien.
 * Une question (« … ? ») n'est jamais une demande de mémorisation.
 */
export function captureExplicitMemory(text: string): string | null {
  if (!text || text.trim().endsWith('?')) return null;
  const match = TRIGGER.exec(text);
  if (!match) return null;
  const cleaned = text
    .slice(match.index + match[0].length)
    .trim()
    .replace(/^[:：,;.\-–—]\s*/, '')
    .trim();
  if (cleaned.length < MEMORY_MIN_CHARS || cleaned.length > MEMORY_MAX_CHARS)
    return null;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(cleaned))) return null;
  return cleaned;
}

/**
 * Forme comparable d'une mémoire : casse, accents, ponctuation et espaces
 * neutralisés. Sert à la déduplication (« Je m'appelle Sam » ≡ « je m appelle
 * sam »).
 */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
