import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * At-rest encryption for provider keys, MCP bearer tokens and external-account
 * credentials. AES-256-GCM with a key derived (scrypt) from a server secret.
 *
 * The SEALING key MUST be `SECRETS_KEY` — never `OWNER_TOKEN` (a leaked owner
 * token would then grant both API access and decryption) and never generated
 * or stored in the database, since a key kept next to its ciphertext protects
 * nothing. `OWNER_TOKEN` is accepted only as a legacy READ fallback for
 * values sealed before this split. When no secret is configured, sealing and
 * reading sealed values throw instead of falling back to plaintext.
 *
 * Wire format (versioned):
 *   enc2:<salt b64>:<iv b64>:<tag b64>:<cipher b64>   (per-value random salt)
 *   enc1:<iv|tag|cipher b64>                           (legacy fixed salt)
 */
const ALGORITHM = 'aes-256-gcm';
/** Fixed salt used by the legacy `enc1` format (and pre-versioned values). */
const LEGACY_SALT = 'nevadots-provider-keys';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENC2 = 'enc2:';
const ENC1 = 'enc1:';

export interface SecretConfigStore {
  configGet(key: string): string | undefined;
  configSet(key: string, value: string): void;
  configDelete(key: string): void;
  configList(prefix: string): { key: string; value: string }[];
}

function deriveKey(secret: string, salt: Buffer | string): Buffer {
  return scryptSync(secret, salt, 32);
}

function requireSecret(secret: string | undefined): string {
  const value = secret?.trim();
  if (!value)
    throw new Error(
      'A server secret (SECRETS_KEY) is required to encrypt or read stored secrets.',
    );
  return value;
}

export function encryptSecret(plain: string, secret: string): string {
  const key = requireSecret(secret);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(key, salt), iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return [
    ENC2.slice(0, -1),
    salt.toString('base64'),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptSecret(
  payload: string,
  secret: string,
  legacySecret?: string,
): string {
  const primary = secret?.trim();
  const legacy = legacySecret?.trim();
  if (!primary && !legacy) requireSecret(secret);
  if (primary) {
    try {
      return openWith(payload, primary);
    } catch (error) {
      // Values sealed with the old OWNER_TOKEN-derived key stay readable.
      if (!legacy || legacy === primary) throw error;
    }
  }
  return openWith(payload, legacy!);
}

function openWith(payload: string, key: string): string {
  if (payload.startsWith(ENC2)) {
    const [, saltB64, ivB64, tagB64, dataB64] = payload.split(':');
    if (!saltB64 || !ivB64 || !tagB64 || dataB64 === undefined)
      throw new Error('Malformed sealed secret.');
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(key, Buffer.from(saltB64, 'base64')),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
  // Legacy: `enc1:` prefix or a bare base64(iv|tag|cipher) value.
  const raw = Buffer.from(
    payload.startsWith(ENC1) ? payload.slice(ENC1.length) : payload,
    'base64',
  );
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(key, LEGACY_SALT), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

/** True when a stored value predates the versioned `enc2` format. */
export function isLegacySecret(payload: string): boolean {
  return !payload.startsWith(ENC2);
}

/**
 * Resolves the SEALING key from the environment only: `SECRETS_KEY`, never
 * `OWNER_TOKEN` (a leaked token must not grant decryption). Returns `''` when
 * unset — callers must then refuse to seal (fail closed) rather than silently
 * storing plaintext.
 */
export function resolveSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.SECRETS_KEY?.trim() || '';
}

/**
 * Legacy READ-only fallback: `OWNER_TOKEN`, accepted solely to decrypt values
 * sealed before SECRETS_KEY became the only sealing key. Never pass it to
 * `encryptSecret`.
 */
export function resolveLegacySecretKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.OWNER_TOKEN?.trim() || '';
}
