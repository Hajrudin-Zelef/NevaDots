import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * At-rest encryption for provider API keys. AES-256-GCM with a key derived
 * (scrypt) from a server secret. The secret is `SECRETS_KEY` (or `OWNER_TOKEN`)
 * when provided, otherwise a random key generated once and stored in the
 * database so ciphertexts survive restarts.
 */
const ALGORITHM = 'aes-256-gcm';
const SALT = 'nevadots-provider-keys';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretConfigStore {
  configGet(key: string): string | undefined;
  configSet(key: string, value: string): void;
  configDelete(key: string): void;
  configList(prefix: string): { key: string; value: string }[];
}

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(payload: string, secret: string): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}

/** Resolves the server secret, generating and persisting one when needed. */
export function resolveSecretKey(
  store: SecretConfigStore,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.SECRETS_KEY?.trim() || env.OWNER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = store.configGet('secrets_key');
  if (stored) return stored;
  const generated = randomBytes(32).toString('base64');
  store.configSet('secrets_key', generated);
  return generated;
}
