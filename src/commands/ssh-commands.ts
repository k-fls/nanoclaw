/**
 * SSH credential management commands — /ssh and /pem.
 *
 * /ssh add|delete|gen|test|reset-host|clear-pending
 * /pem add|delete
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { scopeOf } from '../types.js';
import { logger } from '../logger.js';
import { getSSHManager } from '../auth/ssh/index.js';
import { getTokenResolver } from '../auth/registry.js';
import {
  SSH_PROVIDER_ID,
  PEM_PASSWORDS_PROVIDER_ID,
  isValidAlias,
  isFingerprint,
  parseConnectionString,
  sshToCredential,
  sshFromCredential,
} from '../auth/ssh/types.js';
import type { SSHCredentialMeta } from '../auth/ssh/types.js';
import { updateJsonFile, keysPath } from '../auth/token-substitute.js';
import type { KeysFile } from '../auth/token-substitute.js';
import {
  isGpgAvailable,
  isPgpMessage,
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  normalizeArmoredBlock,
} from '../auth/gpg.js';
import { removePendingRequest, clearAllPending } from '../auth/ssh/pending.js';
import { SSHError, SSHHostKeyMismatchError } from '../auth/ssh/manager.js';
import type { GroupScope, CredentialScope } from '../auth/oauth-types.js';
import { asCredentialScope } from '../auth/oauth-types.js';
import type { ChatIO } from '../interaction/types.js';
import { brandChat } from '../interaction/chat-io.js';
import { reply } from './helpers.js';
import { registerCommand } from './registry.js';

// ── Helpers ───────────────────────────────────────────────────────

const SSH_BRAND = '🔑';

/**
 * Extract a PGP/PEM block from text (possibly after command args).
 * Returns the block or null.
 */
function extractSecretBlock(text: string): string | null {
  // PGP message
  const pgpMatch = text.match(
    /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/,
  );
  if (pgpMatch) return normalizeArmoredBlock(pgpMatch[0]);

  // OpenSSH private key
  const sshMatch = text.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/,
  );
  if (sshMatch) return normalizeArmoredBlock(sshMatch[0]);

  // RSA private key
  const rsaMatch = text.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/,
  );
  if (rsaMatch) return normalizeArmoredBlock(rsaMatch[0]);

  return null;
}

/**
 * Detect if a PEM is passphrase-encrypted.
 */
function isPemEncrypted(pem: string): boolean {
  if (pem.includes('ENCRYPTED')) return true;
  // OpenSSH format: try parsing — if ssh-keygen -y fails without passphrase, it's encrypted
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pem-'));
  const tmpFile = path.join(tmpDir, 'key');
  try {
    fs.writeFileSync(tmpFile, pem, { mode: 0o600 });
    execFileSync('ssh-keygen', ['-y', '-P', '', '-f', tmpFile], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return false; // No passphrase needed
  } catch {
    return true; // Needs passphrase
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Try to strip passphrase from an encrypted PEM using stored passphrases.
 * Returns { strippedPem, publicKey } on success, null on failure.
 */
function tryStripPassphrase(
  pem: string,
  scope: GroupScope,
  hintId?: string,
): { strippedPem: string; publicKey: string } | null {
  const resolver = getTokenResolver();
  const credScope = asCredentialScope(scope);

  // Load PEM password candidates
  const candidates: Array<{ id: string; passphrase: string }> = [];
  if (hintId) {
    const cred = resolver.resolve(credScope, PEM_PASSWORDS_PROVIDER_ID, hintId);
    if (cred) candidates.push({ id: hintId, passphrase: cred.value });
  } else {
    // Scan all stored passphrases in scope
    const keysFile = keysPath(credScope, PEM_PASSWORDS_PROVIDER_ID);
    try {
      const raw = fs.readFileSync(keysFile, 'utf-8');
      const data = JSON.parse(raw) as Record<string, any>;
      for (const [id, entry] of Object.entries(data)) {
        if (id === 'v' || !entry?.value) continue;
        const cred = resolver.resolve(credScope, PEM_PASSWORDS_PROVIDER_ID, id);
        if (cred) candidates.push({ id, passphrase: cred.value });
      }
    } catch {
      // No PEM passwords stored
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-strip-'));
  const tmpFile = path.join(tmpDir, 'key');
  try {
    for (const { passphrase } of candidates) {
      fs.writeFileSync(tmpFile, pem, { mode: 0o600 });
      try {
        // Try extracting public key with this passphrase
        const pubKey = execFileSync(
          'ssh-keygen',
          ['-y', '-P', passphrase, '-f', tmpFile],
          { encoding: 'utf-8', timeout: 5000 },
        ).trim();

        // Strip passphrase
        execFileSync(
          'ssh-keygen',
          ['-p', '-P', passphrase, '-N', '', '-f', tmpFile],
          { timeout: 5000 },
        );

        const strippedPem = fs.readFileSync(tmpFile, 'utf-8');
        return { strippedPem, publicKey: pubKey };
      } catch {
        // Wrong passphrase, try next
        continue;
      }
    }
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Derive public key from an unencrypted PEM.
 */
function derivePublicKey(pem: string): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pub-'));
  const tmpFile = path.join(tmpDir, 'key');
  try {
    fs.writeFileSync(tmpFile, pem, { mode: 0o600 });
    return execFileSync('ssh-keygen', ['-y', '-f', tmpFile], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Parse /ssh add args: alias user@host[:port] [hostKey=*|<fp>] [pem=<id>] [secret block...]
 */
function parseSshAddArgs(args: string): {
  alias: string;
  connStr?: string;
  hostKeyOverride?: string;
  pemHint?: string;
  rest: string;
} | null {
  const firstLine = args.split('\n')[0];
  const parts = firstLine.trim().split(/\s+/);
  if (parts.length < 1) return null;

  const alias = parts[0];
  let connStr: string | undefined;
  let hostKeyOverride: string | undefined;
  let pemHint: string | undefined;
  let restStart = alias.length;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('hostKey=')) {
      hostKeyOverride = p.slice(8);
    } else if (p.startsWith('pem=')) {
      pemHint = p.slice(4);
    } else if (!connStr && p.includes('@')) {
      connStr = p;
    }
    restStart = args.indexOf(p, restStart) + p.length;
  }

  return {
    alias,
    connStr,
    hostKeyOverride,
    pemHint,
    rest: args.slice(restStart),
  };
}

// ── /ssh command ──────────────────────────────────────────────────

registerCommand('ssh', {
  description:
    'SSH credential management — /ssh add|delete|gen|test|reset-host|clear-pending',
  run(args, ctx) {
    if (!args) {
      return reply(
        '*SSH Commands*\n' +
          '`/ssh add <alias> user@host[:port] [hostKey=*|<fingerprint>] [pem=<id>] [GPG/PEM block]`\n' +
          '`/ssh delete <alias>`\n' +
          '`/ssh gen <alias> user@host[:port]`\n' +
          '`/ssh test <alias> [pin] [timeout=N]`\n' +
          '`/ssh reset-host <alias> [hostKey=*|<fingerprint>]`\n' +
          '`/ssh clear-pending`',
      );
    }

    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0];
    const subArgs = args
      .slice(args.indexOf(subcommand) + subcommand.length)
      .trim();
    const scope = scopeOf(ctx.group);

    switch (subcommand) {
      case 'add':
        return handleSshAdd(subArgs, scope, ctx.sendMessageToAgent);
      case 'delete':
        return handleSshDelete(subArgs, scope);
      case 'gen':
        return handleSshGen(subArgs, scope);
      case 'test':
        return handleSshTest(subArgs, scope);
      case 'reset-host':
        return handleSshResetHost(subArgs, scope);
      case 'clear-pending':
        return handleSshClearPending(scope);
      default:
        return reply(
          `Unknown subcommand: ${subcommand}. Use \`/ssh\` for help.`,
        );
    }
  },
});

function handleSshAdd(
  args: string,
  scope: GroupScope,
  sendMessageToAgent: (text: string) => boolean,
) {
  const parsed = parseSshAddArgs(args);
  if (!parsed || !parsed.alias)
    return reply('Usage: `/ssh add <alias> user@host[:port] [GPG/PEM block]`');
  if (!isValidAlias(parsed.alias))
    return reply(
      'Invalid alias. Use alphanumeric, hyphens, underscores. Max 60 chars.',
    );

  const resolver = getTokenResolver();
  const credScope = asCredentialScope(scope);

  // Check if already exists
  const existing = resolver.resolve(credScope, SSH_PROVIDER_ID, parsed.alias);
  if (existing)
    return reply(
      `Credential '${parsed.alias}' already exists. Delete first with \`/ssh delete ${parsed.alias}\`.`,
    );

  if (!parsed.connStr)
    return reply(
      'Connection string required: `/ssh add <alias> user@host[:port]`',
    );
  const conn = parseConnectionString(parsed.connStr);
  if (!conn)
    return reply('Invalid connection string. Use `user@host[:port]` format.');

  // Check for inline secret
  const secretBlock = extractSecretBlock(args);

  if (secretBlock) {
    // Inline secret — process immediately
    return {
      asyncAction: async (io: ChatIO) => {
        const chat = brandChat(io, SSH_BRAND);
        const result = processSecret(
          secretBlock,
          parsed.alias,
          conn,
          scope,
          credScope,
          sendMessageToAgent,
          parsed.hostKeyOverride,
          parsed.pemHint,
        );
        await chat.send(result);
      },
    };
  }

  // No inline secret — prompt for it
  return {
    asyncAction: async (io: ChatIO) => {
      const chat = brandChat(io, SSH_BRAND);
      if (!isGpgAvailable()) {
        await chat.send(
          'GPG is not available. Paste the secret inline with the command.',
        );
        return;
      }
      ensureGpgKey(scope);
      const pubKey = exportPublicKey(scope);
      await chat.sendRaw(pubKey);
      await chat.send(
        'Encrypt your password or private key with the GPG key above and paste it.\n\n' +
          "If you don't have GPG installed locally, use this online tool:\n" +
          '• https://k-fls.github.io/pgp-encrypt/\n\n' +
          'Passphrase-protected PEMs can be pasted directly (if passphrase is registered via `/pem add`).',
      );

      const response = await chat.receive(120000);
      if (!response) {
        await chat.send('Timed out waiting for secret.');
        return;
      }
      chat.hideMessage();

      const block = extractSecretBlock(response);
      if (!block) {
        await chat.send('No PGP/PEM block found in your message.');
        return;
      }

      const result = processSecret(
        block,
        parsed.alias,
        conn,
        scope,
        credScope,
        sendMessageToAgent,
        parsed.hostKeyOverride,
        parsed.pemHint,
      );
      await chat.send(result);
    },
  };
}

function processSecret(
  block: string,
  alias: string,
  conn: { username: string; host: string; port: number },
  scope: GroupScope,
  credScope: CredentialScope,
  sendMessageToAgent: (text: string) => boolean,
  hostKeyOverride?: string,
  pemHint?: string,
): string {
  const resolver = getTokenResolver();

  let secret: string;
  let authType: 'password' | 'key';
  let publicKey: string | undefined;

  if (isPgpMessage(block)) {
    // GPG-encrypted block — decrypt
    const plaintext = gpgDecrypt(scope, block);

    // Detect if it's a PEM or a password
    if (plaintext.includes('PRIVATE KEY')) {
      // It's a PEM key
      if (isPemEncrypted(plaintext)) {
        // Encrypted PEM inside GPG — try stripping passphrase
        const stripped = tryStripPassphrase(plaintext, scope, pemHint);
        if (!stripped) {
          return 'Key is passphrase-protected but no stored passphrase matches. Register with `/pem add <id>` then retry.';
        }
        secret = stripped.strippedPem;
        publicKey = stripped.publicKey;
      } else {
        secret = plaintext;
        publicKey = derivePublicKey(plaintext) || undefined;
      }
      authType = 'key';
    } else {
      // It's a password
      secret = plaintext.trim();
      authType = 'password';
    }
  } else if (block.includes('PRIVATE KEY')) {
    // Direct PEM (must be encrypted — reject unencrypted)
    if (!isPemEncrypted(block)) {
      return 'Unencrypted private key rejected. Encrypt with GPG or protect with a passphrase.';
    }

    const stripped = tryStripPassphrase(block, scope, pemHint);
    if (!stripped) {
      return 'Key is passphrase-protected but no stored passphrase matches. Register with `/pem add <id>` then retry.';
    }
    secret = stripped.strippedPem;
    publicKey = stripped.publicKey;
    authType = 'key';
  } else {
    return 'Unrecognized secret format. Expected a GPG-encrypted block or a passphrase-protected PEM.';
  }

  // Build credential metadata
  let hostKey: string | null = null;
  if (hostKeyOverride === '*') {
    hostKey = '*';
  } else if (hostKeyOverride) {
    if (!isFingerprint(hostKeyOverride)) {
      return 'Invalid hostKey. Use `*` or a fingerprint (`SHA256:...` / `MD5:...`).';
    }
    hostKey = hostKeyOverride;
  }

  const meta: SSHCredentialMeta = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    authType,
    publicKey,
    hostKey,
  };

  resolver.store(
    SSH_PROVIDER_ID,
    credScope,
    alias,
    sshToCredential(secret, meta),
  );
  logger.info({ alias, scope, authType }, 'ssh.credential_stored');

  let msg = `SSH credential '${alias}' stored (${authType}).`;
  if (publicKey) msg += `\nPublic key: \`${publicKey}\``;
  if (hostKey === '*')
    msg += '\n⚠️ Host key verification disabled for this alias.';

  // Check for pending request and notify agent via IPC input
  const wasPending = removePendingRequest(scope, alias);
  if (wasPending) {
    logger.info({ alias, scope }, 'ssh.pending_fulfilled');
    let agentMsg = `SSH credential '${alias}' added.`;
    if (publicKey) agentMsg += ` Public key: ${publicKey}`;
    sendMessageToAgent(agentMsg);
    msg += '\nPending agent request fulfilled.';
  }

  return msg;
}

function handleSshDelete(args: string, scope: GroupScope) {
  const alias = args.trim().split(/\s+/)[0];
  if (!alias || !isValidAlias(alias))
    return reply('Usage: `/ssh delete <alias>`');

  return {
    asyncAction: async (io: ChatIO) => {
      const chat = brandChat(io, SSH_BRAND);
      const sshManager = getSSHManager();
      const credScope = asCredentialScope(scope);

      // Disconnect if active
      await sshManager.disconnect(scope, alias);

      // Delete from keys file
      updateJsonFile<KeysFile>(keysPath(credScope, SSH_PROVIDER_ID), (data) => {
        delete data[alias];
      });

      // Flush cache
      const resolver = getTokenResolver();
      resolver.unloadCache(credScope, SSH_PROVIDER_ID);
      logger.info({ alias, scope }, 'ssh.credential_deleted');

      await chat.send(`SSH credential '${alias}' deleted.`);
    },
  };
}

function handleSshGen(args: string, scope: GroupScope) {
  const parts = args.trim().split(/\s+/);
  const alias = parts[0];
  const connStr = parts[1];

  if (!alias || !isValidAlias(alias))
    return reply('Usage: `/ssh gen <alias> user@host[:port]`');
  if (!connStr)
    return reply(
      'Connection string required: `/ssh gen <alias> user@host[:port]`',
    );

  const conn = parseConnectionString(connStr);
  if (!conn) return reply('Invalid connection string.');

  const resolver = getTokenResolver();
  const credScope = asCredentialScope(scope);

  // Check if already exists
  const existing = resolver.resolve(credScope, SSH_PROVIDER_ID, alias);
  if (existing) return reply(`Credential '${alias}' already exists.`);

  return {
    asyncAction: async (io: ChatIO) => {
      const chat = brandChat(io, SSH_BRAND);
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
          host: conn.host,
          port: conn.port,
          username: conn.username,
          authType: 'key',
          publicKey,
          hostKey: null,
        };

        resolver.store(
          SSH_PROVIDER_ID,
          credScope,
          alias,
          sshToCredential(privateKey, meta),
        );
        logger.info({ alias, scope, authType: 'key' }, 'ssh.credential_stored');

        await chat.send(
          `SSH keypair generated for '${alias}'.\n` +
            `Add this public key to the remote server's \`authorized_keys\`:\n\n\`${publicKey}\``,
        );
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

function handleSshTest(args: string, scope: GroupScope) {
  const parts = args.trim().split(/\s+/);
  const alias = parts[0];
  if (!alias || !isValidAlias(alias))
    return reply('Usage: `/ssh test <alias> [pin] [timeout=N]`');

  const pinFlag = parts.includes('pin');
  let timeout = 5;
  for (const p of parts) {
    if (p.startsWith('timeout=')) {
      timeout = parseInt(p.slice(8), 10) || 5;
    }
  }

  return {
    asyncAction: async (io: ChatIO) => {
      const chat = brandChat(io, SSH_BRAND);
      const sshManager = getSSHManager();
      try {
        const conn = await sshManager.connect(scope, alias, {
          timeout,
          pinAllowed: pinFlag,
        });
        await sshManager.disconnect(scope, alias);
        const hkStatus = conn.hostKeyFingerprint
          ? `Host key: ${conn.hostKeyFingerprint} (${conn.hostKeyAction})`
          : `Host key: (${conn.hostKeyAction})`;
        await chat.send(
          `Connection test for '${alias}' (${conn.username}@${conn.host}:${conn.port}): ✓ Success\n${hkStatus}`,
        );
      } catch (err) {
        if (err instanceof SSHHostKeyMismatchError) {
          await chat.send(
            `HOST KEY MISMATCH for '${err.alias}' (${err.host}:${err.port}).\n` +
              `Stored: ${err.storedFingerprint}\nScanned: ${err.scannedFingerprint}`,
          );
          return;
        }
        if (err instanceof SSHError) {
          await chat.send(
            `Connection test for '${alias}' failed: ${err.message}`,
          );
          return;
        }
        await chat.send(
          `Connection test for '${alias}' failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    },
  };
}

function handleSshResetHost(args: string, scope: GroupScope) {
  const parts = args.trim().split(/\s+/);
  const alias = parts[0];
  if (!alias || !isValidAlias(alias))
    return reply('Usage: `/ssh reset-host <alias> [hostKey=*|<fingerprint>]`');

  let newHostKey: string | null = null;
  for (const p of parts.slice(1)) {
    if (p.startsWith('hostKey=')) {
      const val = p.slice(8);
      if (val !== '*' && !isFingerprint(val)) {
        return reply(
          'Invalid hostKey. Use `*` or a fingerprint (`SHA256:...` / `MD5:...`).',
        );
      }
      newHostKey = val;
    }
  }

  const resolver = getTokenResolver();
  const credScope = asCredentialScope(scope);

  const cred = resolver.resolve(credScope, SSH_PROVIDER_ID, alias);
  if (!cred) return reply(`No credential found for '${alias}'.`);

  const parsed = sshFromCredential(cred);
  if (!parsed) return reply(`Invalid credential format for '${alias}'.`);

  // Update hostKey
  parsed.meta.hostKey = newHostKey;
  resolver.store(
    SSH_PROVIDER_ID,
    credScope,
    alias,
    sshToCredential(parsed.secret, parsed.meta),
  );

  let msg = `Host key cleared for '${alias}'. Next connection will re-verify (TOFU).`;
  if (newHostKey === '*') {
    msg = `⚠️ Host key verification disabled for '${alias}'. All future connections will skip verification.`;
  } else if (newHostKey) {
    msg = `Host key pinned for '${alias}'.`;
  }

  return reply(msg);
}

function handleSshClearPending(scope: GroupScope) {
  const count = clearAllPending(scope);
  return reply(
    `Cleared ${count} pending SSH credential request(s).`,
  );
}

// ── /pem command ──────────────────────────────────────────────────

registerCommand('pem', {
  description: 'PEM passphrase management — /pem add|delete',
  run(args, ctx) {
    if (!args) {
      return reply(
        '*PEM Passphrase Commands*\n' +
          '`/pem add <id> [GPG block]`\n' +
          '`/pem delete <id>`',
      );
    }

    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0];
    const subArgs = args
      .slice(args.indexOf(subcommand) + subcommand.length)
      .trim();
    const scope = scopeOf(ctx.group);

    switch (subcommand) {
      case 'add':
        return handlePemAdd(subArgs, scope);
      case 'delete':
        return handlePemDelete(subArgs, scope);
      default:
        return reply(
          `Unknown subcommand: ${subcommand}. Use \`/pem\` for help.`,
        );
    }
  },
});

function handlePemAdd(args: string, scope: GroupScope) {
  const parts = args.trim().split(/\s+/);
  const id = parts[0];
  if (!id || !isValidAlias(id))
    return reply('Usage: `/pem add <id> [GPG block]`');

  const resolver = getTokenResolver();
  const credScope = asCredentialScope(scope);

  // Check if already exists
  const existing = resolver.resolve(credScope, PEM_PASSWORDS_PROVIDER_ID, id);
  if (existing)
    return reply(
      `PEM passphrase '${id}' already exists. Delete first with \`/pem delete ${id}\`.`,
    );

  // Check for inline GPG block
  const inlineBlock = extractSecretBlock(args);

  if (inlineBlock) {
    if (!isPgpMessage(inlineBlock))
      return reply('Expected a GPG-encrypted block.');
    return {
      asyncAction: async (io: ChatIO) => {
        const chat = brandChat(io, SSH_BRAND);
        const passphrase = gpgDecrypt(scope, inlineBlock).trim();
        resolver.store(PEM_PASSWORDS_PROVIDER_ID, credScope, id, {
          value: passphrase,
          expires_ts: 0,
          updated_ts: Date.now(),
        });
        await chat.send(`PEM passphrase '${id}' stored.`);
      },
    };
  }

  // Prompt for GPG-encrypted passphrase
  return {
    asyncAction: async (io: ChatIO) => {
      const chat = brandChat(io, SSH_BRAND);
      if (!isGpgAvailable()) {
        await chat.send('GPG is not available. Paste the GPG block inline.');
        return;
      }
      ensureGpgKey(scope);
      const pubKey = exportPublicKey(scope);
      await chat.sendRaw(pubKey);
      await chat.send(
        'Encrypt the PEM passphrase with the GPG key above and paste it.\n\n' +
          "If you don't have GPG installed locally, use this online tool:\n" +
          '• https://k-fls.github.io/pgp-encrypt/',
      );

      const response = await chat.receive(120000);
      if (!response) {
        await chat.send('Timed out.');
        return;
      }
      chat.hideMessage();

      const block = extractSecretBlock(response);
      if (!block || !isPgpMessage(block)) {
        await chat.send('No GPG block found.');
        return;
      }

      const passphrase = gpgDecrypt(scope, block).trim();
      resolver.store(PEM_PASSWORDS_PROVIDER_ID, credScope, id, {
        value: passphrase,
        expires_ts: 0,
        updated_ts: Date.now(),
      });
      await chat.send(`PEM passphrase '${id}' stored.`);
    },
  };
}

function handlePemDelete(args: string, scope: GroupScope) {
  const id = args.trim().split(/\s+/)[0];
  if (!id || !isValidAlias(id)) return reply('Usage: `/pem delete <id>`');

  const credScope = asCredentialScope(scope);

  updateJsonFile<KeysFile>(
    keysPath(credScope, PEM_PASSWORDS_PROVIDER_ID),
    (data) => {
      delete data[id];
    },
  );

  const resolver = getTokenResolver();
  resolver.unloadCache(credScope, PEM_PASSWORDS_PROVIDER_ID);

  return reply(`PEM passphrase '${id}' deleted.`);
}
