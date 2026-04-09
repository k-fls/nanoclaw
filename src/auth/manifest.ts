/**
 * Grantor credential manifests — lightweight JSONL files that advertise
 * which credentials a scope offers, distributed to grantees via async cp.
 *
 * Source:      credentials/{scope}/manifests/{providerId}.jsonl
 * Destination: groups/{grantee}/credentials/granted/{grantor}/{providerId}.jsonl
 * Symlink:     groups/{grantee}/credentials/borrowed → granted/{grantor}/
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { CREDENTIALS_DIR } from './store.js';
import type { CredentialScope } from './oauth-types.js';
import { asGroupScope } from './oauth-types.js';
import type { GroupResolver } from './token-substitute.js';
import { readKeysFile } from './token-substitute.js';

// ── Manifest builder registry ───────────────────────────────────────

/**
 * Custom manifest builder — returns JSONL lines for a provider's credentials.
 * Return [] to suppress manifest generation for this provider.
 */
export type ManifestBuilder = (credentialScope: CredentialScope, providerId: string) => string[];

/** Lifecycle hook called after a source manifest is written or deleted. */
export type ManifestHandler = (credentialScope: CredentialScope, providerId: string) => void;

export interface ManifestRegistration {
  builder: ManifestBuilder;
  onWrite?: ManifestHandler;
  onDelete?: ManifestHandler;
}

const registrations = new Map<string, ManifestRegistration>();

/**
 * Register a custom manifest builder (and optional lifecycle hooks) for a provider.
 * Providers that need no manifests should register a builder returning [].
 */
export function registerManifestBuilder(
  providerId: string,
  builder: ManifestBuilder,
  handlers?: { onWrite?: ManifestHandler; onDelete?: ManifestHandler },
): void {
  registrations.set(providerId, { builder, ...handlers });
}

// ── Manifest I/O ────────────────────────────────────────────────────

interface ManifestEntry {
  provider: string;
  name: string;
  credScope: string;
}

/**
 * Derive manifest content from a keys file.
 * Checks the builder registry first; falls back to default logic.
 */
function buildManifestLines(
  credentialScope: CredentialScope,
  providerId: string,
): string[] {
  const reg = registrations.get(providerId);
  if (reg) return reg.builder(credentialScope, providerId);

  // Default: one entry per top-level credential (skips version marker)
  const keys = readKeysFile(credentialScope, providerId);
  const lines: string[] = [];
  for (const [id, entry] of Object.entries(keys)) {
    if (id === 'v') continue;
    if (!entry || typeof entry !== 'object' || !('value' in entry)) continue;
    const obj: ManifestEntry = {
      provider: providerId,
      name: id,
      credScope: credentialScope as string,
    };
    lines.push(JSON.stringify(obj));
  }
  return lines;
}

function manifestDir(credentialScope: CredentialScope): string {
  return path.join(CREDENTIALS_DIR, credentialScope as string, 'manifests');
}

function manifestPath(
  credentialScope: CredentialScope,
  providerId: string,
): string {
  return path.join(manifestDir(credentialScope), `${providerId}.jsonl`);
}

function writeManifest(
  credentialScope: CredentialScope,
  providerId: string,
): void {
  const lines = buildManifestLines(credentialScope, providerId);
  const dir = manifestDir(credentialScope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(credentialScope, providerId), lines.join('\n') + '\n');
}

function deleteManifest(
  credentialScope: CredentialScope,
  providerId: string,
): void {
  try {
    fs.unlinkSync(manifestPath(credentialScope, providerId));
  } catch {
    /* already gone */
  }
}

// ── Grantee distribution ────────────────────────────────────────────

function grantedDir(granteeFolder: string, grantorFolder: string): string {
  return path.join(
    resolveGroupFolderPath(granteeFolder),
    'credentials',
    'granted',
    grantorFolder,
  );
}

function copyManifestToGrantee(
  credentialScope: CredentialScope,
  providerId: string,
  granteeFolder: string,
): void {
  const src = manifestPath(credentialScope, providerId);
  if (!fs.existsSync(src)) return;
  const destDir = grantedDir(granteeFolder, credentialScope as string);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, `${providerId}.jsonl`));
}

function deleteManifestFromGrantee(
  credentialScope: CredentialScope,
  providerId: string,
  granteeFolder: string,
): void {
  try {
    fs.unlinkSync(
      path.join(
        grantedDir(granteeFolder, credentialScope as string),
        `${providerId}.jsonl`,
      ),
    );
  } catch {
    /* already gone */
  }
}

/**
 * Async (fire-and-forget) distribution of a single manifest to all grantees.
 */
function asyncDistribute(
  credentialScope: CredentialScope,
  providerId: string,
  groupResolver: GroupResolver,
  mode: 'copy' | 'delete',
): void {
  // Resolve grantor group to get grantee list
  const grantor = groupResolver(asGroupScope(credentialScope));
  if (!grantor) return;
  const grantees = grantor.containerConfig?.credentialGrantees;
  if (!grantees?.length) return;

  // Fire and forget
  Promise.resolve().then(() => {
    for (const grantee of grantees) {
      try {
        if (mode === 'copy') {
          copyManifestToGrantee(credentialScope, providerId, grantee);
        } else {
          deleteManifestFromGrantee(credentialScope, providerId, grantee);
        }
      } catch (err) {
        logger.warn(
          { err, credentialScope, providerId, grantee },
          `Manifest ${mode} to grantee failed`,
        );
      }
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────

let _groupResolver: GroupResolver | undefined;

/** Set the group resolver used for grantee lookups. Call once during init. */
export function setManifestGroupResolver(resolver: GroupResolver): void {
  _groupResolver = resolver;
}

/**
 * Called after a keys file is written (store or update).
 * Writes manifest + async-distributes to grantees.
 */
export function onKeysFileWritten(
  credentialScope: CredentialScope,
  providerId: string,
): void {
  try {
    writeManifest(credentialScope, providerId);
  } catch (err) {
    logger.warn({ err, credentialScope, providerId }, 'Manifest generation failed');
    return;
  }

  registrations.get(providerId)?.onWrite?.(credentialScope, providerId);

  if (_groupResolver) {
    asyncDistribute(credentialScope, providerId, _groupResolver, 'copy');
  }
}

/**
 * Called after a keys file / scope is deleted.
 * Removes manifest + async-deletes from grantees.
 */
export function onKeysFileDeleted(
  credentialScope: CredentialScope,
  providerId?: string,
): void {
  if (providerId) {
    deleteManifest(credentialScope, providerId);
    registrations.get(providerId)?.onDelete?.(credentialScope, providerId);
    if (_groupResolver) {
      asyncDistribute(credentialScope, providerId, _groupResolver, 'delete');
    }
  } else {
    // Whole scope deleted — remove entire manifests dir
    try {
      fs.rmSync(manifestDir(credentialScope), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    // Clean up from all grantees
    const grantor = _groupResolver?.(asGroupScope(credentialScope));
    const grantees = grantor?.containerConfig?.credentialGrantees;
    if (grantees?.length) {
      Promise.resolve().then(() => {
        for (const grantee of grantees) {
          try {
            fs.rmSync(grantedDir(grantee, credentialScope as string), {
              recursive: true,
              force: true,
            });
          } catch {
            /* best effort */
          }
        }
      });
    }
  }
}

/**
 * Distribute ALL existing manifests from a grantor to a single new grantee.
 * Called by /creds share after adding grantee.
 */
export function distributeAllManifests(
  grantorFolder: string,
  granteeFolder: string,
): void {
  const credentialScope = grantorFolder as unknown as CredentialScope;
  const dir = manifestDir(credentialScope);
  try {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const m = /^(.+)\.jsonl$/.exec(file);
      if (m) {
        copyManifestToGrantee(credentialScope, m[1], granteeFolder);
      }
    }
  } catch (err) {
    logger.warn(
      { err, grantorFolder, granteeFolder },
      'Distribute all manifests failed',
    );
  }
}

/**
 * Remove all manifests from a grantee for a specific grantor.
 * Called by /creds revoke. Also removes the borrowed symlink if it pointed there.
 */
export function revokeGranteeManifests(
  grantorFolder: string,
  granteeFolder: string,
): void {
  try {
    fs.rmSync(grantedDir(granteeFolder, grantorFolder), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best effort */
  }

  // Remove borrowed symlink if it pointed to this grantor
  try {
    const groupDir = resolveGroupFolderPath(granteeFolder);
    const borrowedLink = path.join(groupDir, 'credentials', 'borrowed');
    const target = fs.readlinkSync(borrowedLink);
    if (target === `granted/${grantorFolder}` || target === `granted/${grantorFolder}/`) {
      fs.unlinkSync(borrowedLink);
    }
  } catch {
    /* not a symlink or doesn't exist */
  }
}

/**
 * Create (or update) the borrowed symlink for a grantee.
 * Called by /creds borrow.
 */
export function createBorrowedLink(
  granteeFolder: string,
  grantorFolder: string,
): void {
  const groupDir = resolveGroupFolderPath(granteeFolder);
  const credsDir = path.join(groupDir, 'credentials');
  fs.mkdirSync(credsDir, { recursive: true });
  const link = path.join(credsDir, 'borrowed');
  // ln -sfn equivalent: remove existing, create new
  try {
    fs.unlinkSync(link);
  } catch {
    /* doesn't exist */
  }
  fs.symlinkSync(`granted/${grantorFolder}`, link);
}

/**
 * Remove the borrowed symlink.
 * Called by /creds stop-borrowing.
 */
export function removeBorrowedLink(granteeFolder: string): void {
  try {
    const groupDir = resolveGroupFolderPath(granteeFolder);
    fs.unlinkSync(path.join(groupDir, 'credentials', 'borrowed'));
  } catch {
    /* doesn't exist */
  }
}

/**
 * Regenerate all manifests for all scopes at startup.
 * Scans the credentials directory for keys files and writes manifests.
 */
export function regenerateAllManifests(): void {
  try {
    if (!fs.existsSync(CREDENTIALS_DIR)) return;
    const scopeDirs = fs.readdirSync(CREDENTIALS_DIR, { withFileTypes: true });
    for (const dir of scopeDirs) {
      if (!dir.isDirectory()) continue;
      const scopePath = path.join(CREDENTIALS_DIR, dir.name);
      const files = fs.readdirSync(scopePath);
      for (const file of files) {
        const m = /^(.+)\.keys\.json$/.exec(file);
        if (m) {
          try {
            writeManifest(dir.name as unknown as CredentialScope, m[1]);
          } catch {
            /* best effort */
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to regenerate all manifests');
  }
}
