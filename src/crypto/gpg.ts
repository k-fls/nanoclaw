/**
 * Per-scope GPG key management for secure credential exchange via chat.
 *
 * Each scope gets its own GPG homedir under a caller-provided base directory:
 *   {baseDir}/{scope}/.gnupg/
 * with an auto-generated keypair. The public key is shown to the user so
 * they can encrypt secrets locally before pasting into chat.
 *
 * Key expiry: keys track their creation time and a configurable max age.
 * Expiry is checked only on export (exportPublicKey) — if expired, the key
 * is regenerated before export. Decryption (gpgDecrypt) never checks expiry
 * so existing data is never locked out.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

const GPG_BIN = 'gpg';
const KEY_ID = 'nanoclaw';

/** Default key lifetime in days before regeneration on next export. */
export const DEFAULT_KEY_MAX_AGE_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface GpgKeyMeta {
  createdAt: string; // ISO timestamp
  maxAgeDays: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve the GPG homedir for a given scope under a base directory. */
export function gpgHome(baseDir: string, scope: string): string {
  return path.join(baseDir, scope, '.gnupg');
}

function metaPath(baseDir: string, scope: string): string {
  return path.join(gpgHome(baseDir, scope), 'key-meta.json');
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Check if gpg is available on the host. */
export function isGpgAvailable(): boolean {
  try {
    execFileSync(GPG_BIN, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key metadata & expiry
// ---------------------------------------------------------------------------

/** Read key metadata. Returns null if no metadata file exists. */
export function getKeyMeta(baseDir: string, scope: string): GpgKeyMeta | null {
  const p = metaPath(baseDir, scope);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as GpgKeyMeta;
  } catch {
    return null;
  }
}

/**
 * Check if the GPG key for this scope has expired.
 * Returns false if no metadata exists (legacy keys are treated as non-expired).
 */
export function isKeyExpired(baseDir: string, scope: string): boolean {
  const meta = getKeyMeta(baseDir, scope);
  if (!meta) return false;
  return Date.now() > Date.parse(meta.createdAt) + meta.maxAgeDays * MS_PER_DAY;
}

function writeMeta(baseDir: string, scope: string, maxAgeDays: number): void {
  const meta: GpgKeyMeta = {
    createdAt: new Date().toISOString(),
    maxAgeDays,
  };
  fs.writeFileSync(metaPath(baseDir, scope), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Ensure a GPG keypair exists for the given scope. Creates one if missing.
 * Records creation timestamp and max age in key-meta.json.
 */
export function ensureGpgKey(
  baseDir: string,
  scope: string,
  maxAgeDays?: number,
): void {
  const home = gpgHome(baseDir, scope);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  // Check if key already exists
  try {
    const result = execFileSync(
      GPG_BIN,
      ['--homedir', home, '--list-keys', KEY_ID],
      { stdio: 'pipe' },
    );
    if (result.length > 0) return; // key exists, keep it
  } catch {
    // Key doesn't exist — generate it
  }

  const batchConfig = [
    '%no-protection',
    'Key-Type: RSA',
    'Key-Length: 2048',
    'Subkey-Type: RSA',
    'Subkey-Length: 2048',
    `Name-Real: ${KEY_ID}`,
    `Name-Email: ${scope}@nanoclaw.local`,
    'Expire-Date: 0',
    '%commit',
  ].join('\n');

  execFileSync(GPG_BIN, ['--homedir', home, '--batch', '--gen-key'], {
    input: batchConfig,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  writeMeta(baseDir, scope, maxAgeDays ?? DEFAULT_KEY_MAX_AGE_DAYS);
  logger.info({ scope }, 'Generated GPG keypair');
}

// ---------------------------------------------------------------------------
// Key regeneration (on expiry)
// ---------------------------------------------------------------------------

function regenerateKey(
  baseDir: string,
  scope: string,
  maxAgeDays: number,
): void {
  const home = gpgHome(baseDir, scope);
  fs.rmSync(home, { recursive: true, force: true });
  logger.info({ scope }, 'GPG key expired — regenerating');
  ensureGpgKey(baseDir, scope, maxAgeDays);
}

// ---------------------------------------------------------------------------
// Public key export
// ---------------------------------------------------------------------------

/**
 * Export the ASCII-armored public key for the given scope.
 *
 * If the key has expired (createdAt + maxAgeDays < now), the keypair is
 * regenerated first, then the new public key is exported. Decryption is
 * NOT affected — gpgDecrypt always works regardless of expiry.
 */
export function exportPublicKey(baseDir: string, scope: string): string {
  const meta = getKeyMeta(baseDir, scope);
  if (
    meta &&
    Date.now() > Date.parse(meta.createdAt) + meta.maxAgeDays * MS_PER_DAY
  ) {
    regenerateKey(baseDir, scope, meta.maxAgeDays);
  }

  const home = gpgHome(baseDir, scope);
  const result = execFileSync(
    GPG_BIN,
    ['--homedir', home, '--armor', '--export', KEY_ID],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return result.toString('utf-8').trim();
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/** Decrypt a PGP-encrypted message. Returns the plaintext. Never checks key expiry. */
export function gpgDecrypt(
  baseDir: string,
  scope: string,
  ciphertext: string,
): string {
  const home = gpgHome(baseDir, scope);
  const result = execFileSync(
    GPG_BIN,
    ['--homedir', home, '--batch', '--quiet', '--decrypt'],
    { input: ciphertext, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return result.toString('utf-8').trim();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Detect if a string contains a PGP-encrypted message. */
export function isPgpMessage(text: string): boolean {
  return text.includes('-----BEGIN PGP MESSAGE-----');
}
