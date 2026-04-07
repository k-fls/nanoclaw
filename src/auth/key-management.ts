/**
 * Key management for discovery-file providers.
 *
 * Handles interactive GPG-based key setup, non-interactive set-key,
 * and credential deletion for any bearer-swap-capable provider.
 */
import type { GroupScope, CredentialScope } from './oauth-types.js';
import { asCredentialScope } from './oauth-types.js';
import type { TokenSubstituteEngine } from './token-substitute.js';
import { readKeysFile, type Credential } from './token-substitute.js';
import type { ChatIO } from './types.js';
import {
  getDiscoveryProvider,
  getAllDiscoveryProviderIds,
} from './registry.js';
import {
  isGpgAvailable,
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  isPgpMessage,
} from './gpg.js';
import { logger } from '../logger.js';

const PGP_BEGIN = '-----BEGIN PGP MESSAGE-----';
const IDLE_TIMEOUT = 120_000;
const KEY_SETUP_PREFIX = '🔑🤖';

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** A provider is eligible for manual key setup if it has bearer-swap rules. */
export function isKeyEligibleProvider(providerId: string): boolean {
  const provider = getDiscoveryProvider(providerId);
  if (!provider) return false;
  return provider.rules.some((r) => r.mode === 'bearer-swap');
}

// ---------------------------------------------------------------------------
// Credential ID detection
// ---------------------------------------------------------------------------

/**
 * Collect known credential IDs from additive sources.
 * 1. Existing keys on disk for this provider/scope (top-level entries)
 * 2. envVars values declared on the OAuthProvider
 */
export function getProviderCredentialIds(
  providerId: string,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
): Set<string> {
  const ids = new Set<string>();

  // Source 1: existing keys on disk
  const credScope = tokenEngine.resolveCredentialScope(groupScope, providerId);
  const keys = readKeysFile(credScope, providerId);
  for (const [id, entry] of Object.entries(keys)) {
    if (id === 'v') continue;
    if (entry && typeof entry === 'object' && 'value' in entry) ids.add(id);
  }

  // Source 2: envVars from discovery provider
  const provider = getDiscoveryProvider(providerId);
  if (provider?.envVars) {
    for (const credPath of Object.values(provider.envVars)) {
      // Only add top-level credential IDs (not nested paths like 'oauth/refresh')
      if (!credPath.includes('/')) ids.add(credPath);
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Store (generalized from claude.ts storeResult pattern)
// ---------------------------------------------------------------------------

/**
 * Store a key for a discovery provider.
 * Clears old credentials first, then stores the new key, then prunes stale refs.
 *
 * Returns whether the user should restart the container (env var was
 * never populated because no substitute existed before).
 */
export function storeProviderKey(
  providerId: string,
  groupScope: GroupScope,
  credentialId: string,
  token: string,
  expiresTs: number,
  tokenEngine: TokenSubstituteEngine,
): { needsRestart: boolean } {
  const credScope = asCredentialScope(String(groupScope));
  const resolver = tokenEngine.getResolver();

  // Check if any env var for this credential had no substitute yet
  let needsRestart = false;
  const provider = getDiscoveryProvider(providerId);
  if (provider?.envVars) {
    for (const [_envVar, envCredPath] of Object.entries(provider.envVars)) {
      if (envCredPath === credentialId) {
        const existing = tokenEngine.getSubstitute(
          providerId,
          groupScope,
          credentialId,
        );
        if (!existing) needsRestart = true;
        break;
      }
    }
  }

  // Clear → store → prune
  tokenEngine.clearCredentials(groupScope, providerId);
  resolver.store(token, providerId, credScope, credentialId, expiresTs);
  tokenEngine.pruneStaleRefs(groupScope, providerId);

  return { needsRestart };
}

// ---------------------------------------------------------------------------
// Interactive key setup (scenario b)
// ---------------------------------------------------------------------------

export async function runInteractiveKeySetup(
  providerId: string,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
  chat: ChatIO,
): Promise<boolean> {
  if (!isKeyEligibleProvider(providerId)) {
    await chat.send(
      `${KEY_SETUP_PREFIX} Provider *${providerId}* has no bearer-swap rules — ` +
        `it cannot be configured for manual key setup.`,
    );
    return false;
  }

  // Determine credential ID
  const credIds = getProviderCredentialIds(providerId, groupScope, tokenEngine);
  let credentialId: string;

  if (credIds.size === 0) {
    await chat.send(
      `${KEY_SETUP_PREFIX} Provider *${providerId}* is not configured for manual key setup ` +
        `(no known credentials from existing keys or env var declarations).`,
    );
    return false;
  } else if (credIds.size === 1) {
    credentialId = [...credIds][0];
  } else {
    // Multiple credentials — ask user to choose
    const credList = [...credIds];
    const menu = credList.map((r, i) => `${i + 1}. ${r}`).join('\n');
    await chat.send(
      `${KEY_SETUP_PREFIX} Multiple credentials available for *${providerId}*:\n\n` +
        `${menu}\n\nReply with a number.`,
    );
    const reply = await chat.receive(IDLE_TIMEOUT);
    if (!reply) {
      await chat.send(`${KEY_SETUP_PREFIX} Timed out.`);
      return false;
    }
    chat.hideMessage();
    chat.advanceCursor();
    const choice = parseInt(reply.trim(), 10);
    if (isNaN(choice) || choice < 1 || choice > credList.length) {
      await chat.send(`${KEY_SETUP_PREFIX} Cancelled.`);
      return false;
    }
    credentialId = credList[choice - 1];
  }

  // GPG setup
  if (!isGpgAvailable()) {
    await chat.send(
      `${KEY_SETUP_PREFIX} GPG is not installed. ` +
        `Install it (\`apt install gnupg\` or \`brew install gnupg\`) and try again.`,
    );
    return false;
  }

  const scope = String(groupScope);
  try {
    ensureGpgKey(scope);
  } catch (err) {
    await chat.send(
      `${KEY_SETUP_PREFIX} Failed to initialize GPG keypair: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  const pubKey = exportPublicKey(scope);
  await chat.sendRaw(pubKey);
  await chat.send(
    `Paste a GPG-encrypted key for *${providerId}* (*${credentialId}*).\n\n` +
      `*Step 1.* Import the public key above.\n` +
      '```\n' +
      "gpg --import <<'EOF'\n" +
      '... (paste the key) ...\n' +
      'EOF\n' +
      '```\n\n' +
      `*Step 2.* Encrypt your key:\n` +
      '```\n' +
      'echo "your-api-key" | gpg --encrypt --armor --recipient nanoclaw\n' +
      '```\n\n' +
      '*Step 3.* Paste the encrypted output here. Reply "cancel" to abort.',
  );

  const reply = await chat.receive(IDLE_TIMEOUT);
  if (!reply || reply.trim().toLowerCase() === 'cancel') {
    await chat.send(`${KEY_SETUP_PREFIX} Cancelled.`);
    return false;
  }
  chat.hideMessage();
  chat.advanceCursor();

  if (!isPgpMessage(reply)) {
    await chat.send(
      `${KEY_SETUP_PREFIX} Expected a GPG-encrypted message (${PGP_BEGIN}).\n` +
        `Plaintext keys are not accepted for security reasons.`,
    );
    return false;
  }

  let plaintext: string;
  try {
    plaintext = gpgDecrypt(scope, reply.trim());
  } catch (err) {
    await chat.send(
      `${KEY_SETUP_PREFIX} Failed to decrypt PGP message. ` +
        `Make sure you encrypted with the public key shown above.`,
    );
    logger.error({ scope, err }, 'GPG decrypt failed');
    return false;
  }

  const { needsRestart } = storeProviderKey(
    providerId,
    groupScope,
    credentialId,
    plaintext.trim(),
    0,
    tokenEngine,
  );

  let msg = `${KEY_SETUP_PREFIX} Key stored for *${providerId}* (*${credentialId}*).`;
  if (needsRestart) {
    msg +=
      '\n⚠️ Container restart may be needed for the new key to take effect.';
  }
  await chat.send(msg);
  logger.info(
    { groupScope, providerId, credentialId },
    'Key stored via interactive setup',
  );
  return true;
}

// ---------------------------------------------------------------------------
// Non-interactive set-key (scenario c)
// ---------------------------------------------------------------------------

export function handleSetKey(
  providerId: string,
  argsAfterSetKey: string,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
): string {
  if (!isKeyEligibleProvider(providerId)) {
    return `Provider *${providerId}* has no bearer-swap rules — cannot store keys.`;
  }

  // Find PGP block (may start on same line or a subsequent line)
  const pgpIdx = argsAfterSetKey.indexOf(PGP_BEGIN);
  if (pgpIdx < 0 || !isPgpMessage(argsAfterSetKey.slice(pgpIdx))) {
    return (
      `Expected a GPG-encrypted message.\n` +
      `Usage: /auth ${providerId} set-key [credential-id] [expiry=<seconds>] <pgp block>`
    );
  }

  const pgpBlock = argsAfterSetKey.slice(pgpIdx);
  const prefix = argsAfterSetKey.slice(0, pgpIdx).trim();

  // Parse optional credential ID and expiry from tokens before the PGP block
  const tokens = prefix.split(/\s+/).filter(Boolean);
  let credentialId: string | undefined;
  let expiry = 0;

  const knownIds = getProviderCredentialIds(providerId, groupScope, tokenEngine);
  for (const tok of tokens) {
    if (knownIds.has(tok)) {
      credentialId = tok;
    } else if (tok.startsWith('expiry=')) {
      const val = parseInt(tok.slice(7), 10);
      if (!isNaN(val)) expiry = val;
    }
  }

  // Default credential ID from provider
  if (!credentialId) {
    credentialId = knownIds.size === 1 ? [...knownIds][0] : 'oauth';
  }

  // Decrypt
  const scope = String(groupScope);
  if (!isGpgAvailable()) {
    return 'GPG is not available. Install gnupg first.';
  }
  ensureGpgKey(scope);

  let plaintext: string;
  try {
    plaintext = gpgDecrypt(scope, pgpBlock.trim());
  } catch (err) {
    logger.error({ scope, err }, 'GPG decrypt failed in set-key');
    return 'Failed to decrypt PGP message. Make sure you encrypted with the correct public key.';
  }

  const { needsRestart } = storeProviderKey(
    providerId,
    groupScope,
    credentialId,
    plaintext.trim(),
    expiry,
    tokenEngine,
  );

  let msg = `Key stored for *${providerId}* (*${credentialId}*).`;
  if (needsRestart) {
    msg +=
      '\n⚠️ Container restart may be needed for the new key to take effect.';
  }
  logger.info({ groupScope, providerId, credentialId }, 'Key stored via set-key');
  return msg;
}

// ---------------------------------------------------------------------------
// Delete (scenario d)
// ---------------------------------------------------------------------------

export function handleDeleteKeys(
  providerId: string,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
): string {
  if (!getDiscoveryProvider(providerId)) {
    const known = getAllDiscoveryProviderIds();
    return `Unknown provider: ${providerId}\nKnown providers: ${known.join(', ')}`;
  }

  const count = tokenEngine.revokeByScope(groupScope, providerId);
  logger.info(
    { groupScope, providerId, count },
    'Credentials deleted via /auth delete',
  );
  return `Credentials deleted for *${providerId}* (${count} substitute${count !== 1 ? 's' : ''} revoked).`;
}
