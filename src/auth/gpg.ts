/**
 * Per-group GPG key management — thin wrapper over src/crypto/gpg.
 *
 * Re-exports the scope-only convenience API after binding the base
 * directory to ~/.config/nanoclaw/credentials/. Callers that already
 * import from this file (ensureGpgKey, exportPublicKey, gpgDecrypt,
 * isPgpMessage, isGpgAvailable) keep working with the same signatures.
 */
import os from 'os';
import path from 'path';

import { initGpg, gpg, isGpgAvailable, isPgpMessage } from '../crypto/index.js';

export { isGpgAvailable, isPgpMessage } from '../crypto/index.js';

const CONFIG_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
);
const CREDENTIALS_DIR = path.join(CONFIG_DIR, 'credentials');

// Eagerly bind the default base dir so callers never need to pass it.
initGpg(CREDENTIALS_DIR);

/** Ensure a GPG keypair exists for the given scope. Creates one if missing. */
export function ensureGpgKey(scope: string): void {
  gpg.ensure(scope);
}

/** Export the ASCII-armored public key for the given scope. */
export function exportPublicKey(scope: string): string {
  return gpg.export(scope);
}

/** Decrypt a PGP-encrypted message. Returns the plaintext. */
export function gpgDecrypt(scope: string, ciphertext: string): string {
  return gpg.decrypt(scope, ciphertext);
}
