/**
 * Crypto barrel — initialization, backend access, convenience wrappers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AesSecretBackend } from './aes.js';
import { isEncrypted } from './types.js';
import { logger } from '../logger.js';

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { SecretBackend } from './types.js';
export { isEncrypted, ENC_PREFIX } from './types.js';
export { AesSecretBackend } from './aes.js';
export type { GpgKeyMeta } from './gpg.js';
export {
  isGpgAvailable,
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  isPgpMessage,
  gpgHome,
  isKeyExpired,
  getKeyMeta,
  initGpg,
  gpg,
  DEFAULT_KEY_MAX_AGE_DAYS,
} from './gpg.js';

// ── Defaults ────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
);
const DEFAULT_KEY_PATH = path.join(CONFIG_DIR, 'encryption-key');

// ── Singleton ───────────────────────────────────────────────────────────────

let backend: AesSecretBackend | null = null;

/**
 * Initialize encryption. Generates the key file if missing, then loads
 * the AES-256-GCM backend. Must be called once at startup before any
 * encrypt/decrypt calls.
 */
export function initEncryption(keyPath?: string): void {
  const resolved = keyPath ?? DEFAULT_KEY_PATH;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  backend = AesSecretBackend.fromKeyFile(resolved);
  logger.info('Encryption initialized');
}

/** Get the initialized secret backend. Throws if not initialized. */
export function getSecretBackend(): AesSecretBackend {
  if (!backend) {
    throw new Error('Encryption not initialized — call initEncryption() first');
  }
  return backend;
}

// ── Convenience wrappers ────────────────────────────────────────────────────

/** Encrypt plaintext with the file-based AES backend. */
export function encrypt(plaintext: string): string {
  return getSecretBackend().encrypt(plaintext);
}

/** Decrypt value with the file-based AES backend. Passes through plaintext. */
export function decrypt(value: string): string {
  return getSecretBackend().decrypt(value);
}

// ── Key rotation helpers ────────────────────────────────────────────────────

/**
 * Check whether a value needs re-encryption (encrypted with a different key).
 * Returns false for plaintext values.
 */
export function needsReEncryption(value: string): boolean {
  if (!backend) return false;
  return isEncrypted(value) && !backend.isCurrentKey(value);
}

/**
 * Re-encrypt a value with the current key. Decrypts then re-encrypts.
 * If the value is plaintext, just encrypts it.
 */
export function reEncrypt(value: string): string {
  return encrypt(decrypt(value));
}
