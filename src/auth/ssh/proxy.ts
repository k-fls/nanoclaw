/**
 * SSH proxy HTTP endpoints.
 *
 * Four endpoints on the credential proxy, all behind validateCaller
 * (scope derived from container IP):
 *
 *   POST /ssh/request-credential — generate key or notify user
 *   POST /ssh/connect            — establish ControlMaster, return usage
 *   POST /ssh/disconnect         — tear down ControlMaster
 *   GET  /ssh/connections        — list active connections for scope
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../../logger.js';
import type {
  GroupScope,
  CredentialScope,
  CredentialResolver,
} from '../oauth-types.js';
import { asCredentialScope } from '../oauth-types.js';
import {
  SSH_PROVIDER_ID,
  sshToCredential,
  sshFromCredential,
  isValidAlias,
} from './types.js';
import type { SSHCredentialMeta } from './types.js';
import {
  containerSocketPath,
  SSHManager,
  SSHError,
  SSHHostKeyMismatchError,
} from './manager.js';
import { addPendingRequest } from './pending.js';
import type { ContainerSessionContext } from '../session-context.js';

// ── Handler ───────────────────────────────────────────────────────

export interface SSHProxyDeps {
  sshManager: SSHManager;
  resolver: CredentialResolver;
  getSessionContext: (scope: GroupScope) => ContainerSessionContext | undefined;
}

/**
 * Route an SSH-related request. Returns true if handled.
 */
export function routeSSHRequest(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): boolean {
  const url = req.url || '';

  if (url === '/ssh/request-credential' && req.method === 'POST') {
    handleRequestCredential(deps, req, res, scope).catch((err) => {
      logger.error({ err }, 'SSH request-credential handler error');
      sendJson(res, 500, {
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
    });
    return true;
  }

  if (url === '/ssh/connect' && req.method === 'POST') {
    handleConnect(deps, req, res, scope).catch((err) => {
      logger.error({ err }, 'SSH connect handler error');
      sendJson(res, 500, {
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
    });
    return true;
  }

  if (url === '/ssh/disconnect' && req.method === 'POST') {
    handleDisconnect(deps, req, res, scope).catch((err) => {
      logger.error({ err }, 'SSH disconnect handler error');
      sendJson(res, 500, {
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
    });
    return true;
  }

  if (url === '/ssh/connections' && req.method === 'GET') {
    const conns = deps.sshManager.listConnections(scope);
    sendJson(res, 200, {
      status: 'ok',
      connections: conns.map((c) => ({
        alias: c.alias,
        host: c.host,
        port: c.port,
        username: c.username,
      })),
    });
    return true;
  }

  return false;
}

// ── Endpoint handlers ─────────────────────────────────────────────

async function handleRequestCredential(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): Promise<void> {
  const body = await readBody(req);
  const { alias, mode, connection_host, connection_port, connection_username } =
    body;

  if (!alias || !isValidAlias(alias)) {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_alias',
      message: 'Invalid alias',
    });
    return;
  }
  if (mode !== 'generate' && mode !== 'ask') {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_mode',
      message: 'Mode must be generate or ask',
    });
    return;
  }

  const credScope = asCredentialScope(scope);

  // Check if credential already exists
  const existing = deps.resolver.resolve(credScope, SSH_PROVIDER_ID, alias);
  if (existing) {
    const parsed = sshFromCredential(existing);
    sendJson(res, 200, {
      status: 'ok',
      publicKey: parsed?.meta.publicKey || undefined,
    });
    return;
  }

  if (mode === 'generate') {
    if (!connection_username || !connection_host) {
      sendJson(res, 400, {
        status: 'error',
        code: 'missing_params',
        message:
          'connection_host and connection_username required for generate mode',
      });
      return;
    }

    // Generate ed25519 keypair
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-keygen-'));
    const keyPath = path.join(tmpDir, 'key');
    try {
      execFileSync(
        'ssh-keygen',
        ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `nanoclaw-${alias}`],
        { timeout: 10000 },
      );

      const privateKey = fs.readFileSync(keyPath, 'utf-8');
      const publicKey = fs.readFileSync(keyPath + '.pub', 'utf-8').trim();

      const meta: SSHCredentialMeta = {
        host: connection_host,
        port: connection_port || 22,
        username: connection_username,
        authType: 'key',
        publicKey,
        hostKey: null,
      };

      deps.resolver.store(
        SSH_PROVIDER_ID,
        credScope,
        alias,
        sshToCredential(privateKey, meta),
      );
      logger.info({ alias, scope, authType: 'key' }, 'ssh.credential_stored');

      sendJson(res, 200, { status: 'ok', publicKey });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  // mode === 'ask': record pending request and notify user
  const { accepted, capReached } = addPendingRequest(scope, alias);

  if (!accepted) {
    sendJson(res, 200, { status: 'suppressed' });
    return;
  }

  logger.info({ alias, scope }, 'ssh.pending_request');

  // Build notification message
  let connInfo = alias;
  if (connection_username && connection_host) {
    connInfo = `${connection_username}@${connection_host}`;
    if (connection_port && connection_port !== 22)
      connInfo += `:${connection_port}`;
    connInfo = `${alias} (${connInfo})`;
  }

  let msg = `SSH credential requested: *${connInfo}*\n`;
  msg += `Use \`/ssh add ${alias} ${connection_username || 'user'}@${connection_host || 'host'}\` to provide credentials.`;

  if (capReached) {
    msg +=
      '\n\n⚠️ SSH credential request limit reached (10). Further requests will be suppressed until pending entries are resolved or cleared with `/ssh clear-pending`.';
  }

  notifyUser(deps, scope, msg);
  sendJson(res, 200, { status: 'pending' });
}

async function handleConnect(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): Promise<void> {
  const body = await readBody(req);
  const { alias, timeout } = body;

  if (!alias || !isValidAlias(alias)) {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_alias',
      message: 'Invalid alias',
    });
    return;
  }

  try {
    const conn = await deps.sshManager.connect(scope, alias, {
      timeout,
      pinAllowed: true,
    });

    if (conn.hostKeyAction === 'pinned') {
      const fp = conn.hostKeyFingerprint || '(unknown)';
      notifyUser(
        deps,
        scope,
        `Host key for ${alias} (${conn.host}:${conn.port}) pinned: ${fp}`,
      );
    }

    const containerSock = containerSocketPath(alias);
    const dest = `${conn.username}@${conn.host}`;
    const usage = [
      `SSH connection established for '${alias}' (${dest}:${conn.port}).`,
      `Usage:`,
      `  ssh -o ControlPath=${containerSock} _ [command]`,
      `  scp -o ControlPath=${containerSock} local.txt ${dest}:/remote/`,
      `  rsync -e "ssh -o ControlPath=${containerSock}" src/ ${dest}:/dest/`,
    ].join('\n');

    sendJson(res, 200, { status: 'ok', alias, usage });
  } catch (err) {
    if (err instanceof SSHHostKeyMismatchError) {
      const msg =
        `⚠️ HOST KEY MISMATCH for ${err.alias} (${err.host}:${err.port}).\n` +
        `Stored: ${err.storedFingerprint}\nScanned: ${err.scannedFingerprint}\n` +
        `Connection refused.\n` +
        `To pin the new key: \`/ssh reset-host ${err.alias} hostKey=${err.scannedFingerprint}\``;
      notifyUser(deps, scope, msg);
      logger.warn(
        {
          alias,
          storedFp: err.storedFingerprint,
          scannedFp: err.scannedFingerprint,
        },
        'ssh.host_key_mismatch',
      );
      sendJson(res, 200, {
        status: 'error',
        code: 'host_key_mismatch',
        message: err.message,
      });
      return;
    }
    if (err instanceof SSHError) {
      sendJson(res, 200, {
        status: 'error',
        code: err.code,
        message: err.message,
      });
      return;
    }
    throw err;
  }
}

async function handleDisconnect(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): Promise<void> {
  const body = await readBody(req);
  const { alias } = body;

  if (!alias || !isValidAlias(alias)) {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_alias',
      message: 'Invalid alias',
    });
    return;
  }

  await deps.sshManager.disconnect(scope, alias);
  sendJson(res, 200, { status: 'ok' });
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Push a notification onto the group's interaction queue.
 * Uses the session context already registered on the proxy for this scope.
 * Best-effort: silently drops if no active session (container already exited).
 */
function notifyUser(
  deps: SSHProxyDeps,
  scope: GroupScope,
  message: string,
): void {
  const ctx = deps.getSessionContext(scope);
  if (!ctx) return;
  ctx.interactionQueue.push(
    {
      interactionId: randomUUID(),
      eventType: 'notification',
      sourceId: 'SSH',
      eventParam: message,
      replyFn: null,
    },
    'ssh notification',
  );
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
  });
}
