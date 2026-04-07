/**
 * CredentialStore — file-based CRUD for credential records.
 *
 * Credentials stored at ~/.config/nanoclaw/credentials/{scope}/{service}.json
 * Encryption is handled by src/crypto (AES-256-GCM).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initEncryption, encrypt, decrypt } from '../crypto/index.js';
import type { StoredCredential } from './types.js';

export { encrypt, decrypt } from '../crypto/index.js';

const CONFIG_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
);
export const CREDENTIALS_DIR = path.join(CONFIG_DIR, 'credentials');
export const DISCOVERY_CACHE_DIR = path.join(
  CREDENTIALS_DIR,
  'oauth-discovery',
);

/** Initialize encryption key and credential directories. */
export function initCredentialStore(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  initEncryption();
}

function credPath(scope: string, service: string): string {
  return path.join(CREDENTIALS_DIR, scope, `${service}.json`);
}

export function hasCredential(scope: string, service: string): boolean {
  return fs.existsSync(credPath(scope, service));
}

export function loadCredential(
  scope: string,
  service: string,
): StoredCredential | null {
  const p = credPath(scope, service);
  try {
    const data = fs.readFileSync(p, 'utf-8');
    return JSON.parse(data) as StoredCredential;
  } catch {
    return null;
  }
}

export function saveCredential(
  scope: string,
  service: string,
  cred: StoredCredential,
): void {
  const p = credPath(scope, service);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
}

export function deleteCredential(scope: string, service: string): void {
  const p = credPath(scope, service);
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}
