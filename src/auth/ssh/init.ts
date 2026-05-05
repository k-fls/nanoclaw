/**
 * SSH subsystem initialization.
 *
 * Registers the 'ssh' and 'pem-passwords' providers with the manifest
 * builder registry, creates the SSHManager instance, and hooks into the
 * credential proxy for HTTP endpoints.
 *
 * Called from initAuthSystem() after the credential proxy and token engine
 * are initialized.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../../logger.js';
import { registerManifestBuilder } from '../manifest.js';
import { readKeysFile } from '../token-substitute.js';
import type {
  CredentialScope,
  GroupScope,
  CredentialResolver,
} from '../oauth-types.js';
import type { ScopeAccessCheck } from '../oauth-types.js';
import type { GroupResolver } from '../token-substitute.js';
import type { CredentialProxy } from '../credential-proxy.js';
import type { ContainerSessionContext } from '../session-context.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import {
  SSH_PROVIDER_ID,
  PEM_PASSWORDS_PROVIDER_ID,
  sshFromCredential,
} from './types.js';
import { SSHManager } from './manager.js';
import { routeSSHRequest } from './proxy.js';
import type { SSHProxyDeps } from './proxy.js';

// ── Singleton ─────────────────────────────────────────────────────

let _sshManager: SSHManager | null = null;

export function getSSHManager(): SSHManager {
  if (!_sshManager) throw new Error('SSH manager not initialized');
  return _sshManager;
}

// ── Manifest builders ─────────────────────────────────────────────

/**
 * SSH manifest builder: enriches entries with connection metadata from
 * authFields, excluding publicKey and hostKey (agent retrieves those
 * explicitly via ssh_request_credential).
 */
function sshManifestBuilder(
  credentialScope: CredentialScope,
  providerId: string,
): string[] {
  const keys = readKeysFile(credentialScope, providerId);
  const lines: string[] = [];
  for (const [id, entry] of Object.entries(keys)) {
    if (id === 'v') continue;
    if (!entry || typeof entry !== 'object' || !('value' in entry)) continue;
    const af = entry.authFields;
    if (!af?.host) continue;
    const obj: Record<string, string | number> = {
      provider: SSH_PROVIDER_ID,
      name: id,
      credScope: credentialScope as string,
      host: af.host,
      port: parseInt(af.port, 10) || 22,
      username: af.username,
    };
    lines.push(JSON.stringify(obj));
  }
  return lines;
}

/**
 * Copy source manifest to the group's own credentials/manifests/ directory.
 * This makes it visible to the agent at /workspace/group/credentials/manifests/ssh.jsonl.
 */
function copyManifestToGroupDir(
  credentialScope: CredentialScope,
  providerId: string,
): void {
  try {
    const srcDir = path.join(
      process.env.HOME || require('os').homedir(),
      '.config',
      'nanoclaw',
      'credentials',
      credentialScope as string,
      'manifests',
    );
    const srcPath = path.join(srcDir, `${providerId}.jsonl`);
    if (!fs.existsSync(srcPath)) return;

    const groupDir = resolveGroupFolderPath(credentialScope as string);
    const dstDir = path.join(groupDir, 'credentials', 'manifests');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(srcPath, path.join(dstDir, `${providerId}.jsonl`));
  } catch {
    // Group dir may not exist (e.g. scope is 'default')
  }
}

function removeManifestFromGroupDir(
  credentialScope: CredentialScope,
  providerId: string,
): void {
  try {
    const groupDir = resolveGroupFolderPath(credentialScope as string);
    const dstPath = path.join(
      groupDir,
      'credentials',
      'manifests',
      `${providerId}.jsonl`,
    );
    fs.unlinkSync(dstPath);
  } catch {
    // Already gone or group doesn't exist
  }
}

// ── Initialization ────────────────────────────────────────────────

/**
 * Initialize the SSH subsystem and wire proxy endpoints.
 *
 * Single entry point called from auth/init.ts. Registers manifest builders,
 * creates the SSH manager, and hooks HTTP endpoints into the credential proxy.
 */
export function initSSHSystem(
  resolver: CredentialResolver,
  groupResolver: GroupResolver,
  accessCheck: ScopeAccessCheck,
  proxy: CredentialProxy,
): SSHManager {
  // Startup sweep: clean stale sockets
  SSHManager.startupSweep();

  // Reserve SSH provider IDs in the manifest builder registry
  registerManifestBuilder(SSH_PROVIDER_ID, sshManifestBuilder, {
    onWrite: copyManifestToGroupDir,
    onDelete: removeManifestFromGroupDir,
  });
  registerManifestBuilder(PEM_PASSWORDS_PROVIDER_ID, () => []);

  // Create SSH manager
  const sshManager = new SSHManager(resolver);
  sshManager.setAccessCheck(accessCheck);
  sshManager.setGroupResolver(groupResolver);
  _sshManager = sshManager;

  // Wire SSH proxy endpoints
  const sshProxyDeps: SSHProxyDeps = {
    sshManager,
    resolver,
    getSessionContext: (scope) => proxy.getSessionContext(scope),
  };
  proxy.addInternalHandler((req, res, scope) =>
    routeSSHRequest(sshProxyDeps, req, res, scope),
  );

  logger.info('SSH subsystem initialized');
  return sshManager;
}
