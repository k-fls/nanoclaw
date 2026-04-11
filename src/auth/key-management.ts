/**
 * Key management for discovery-file providers.
 *
 * Handles interactive GPG-based key setup, non-interactive set-key,
 * and credential deletion for any bearer-swap-capable provider.
 */
import type { GroupScope, CredentialScope } from './oauth-types.js';
import { CRED_OAUTH, asCredentialScope } from './oauth-types.js';
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
  normalizeArmoredBlock,
  promptGpgEncrypt,
  formatGpgInstructions,
} from './gpg.js';
import { chooseName, AUTH_PROMPT_TIMEOUT } from './chat-prompts.js';
import { logger } from '../logger.js';

const PGP_BEGIN = '-----BEGIN PGP MESSAGE-----';

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

  // Source 1: own scope keys on disk
  const ownScope = asCredentialScope(groupScope);
  const ownKeys = readKeysFile(ownScope, providerId);
  for (const [id, entry] of Object.entries(ownKeys)) {
    if (id === 'v') continue;
    if (entry && typeof entry === 'object' && 'value' in entry) ids.add(id);
  }

  // Source 2: borrowed scope keys on disk (if configured)
  const group = tokenEngine.groupResolverFn?.(groupScope);
  const sourceName = group?.containerConfig?.credentialSource;
  if (sourceName) {
    const sourceScope = asCredentialScope(sourceName);
    const sourceKeys = readKeysFile(sourceScope, providerId);
    for (const [id, entry] of Object.entries(sourceKeys)) {
      if (id === 'v') continue;
      if (entry && typeof entry === 'object' && 'value' in entry) ids.add(id);
    }
  }

  // Source 3: envVars from discovery provider
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
  tokenEngine.storeGroupCredential(groupScope, providerId, credentialId, {
    value: token,
    expires_ts: expiresTs,
    updated_ts: Date.now(),
  });
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
      `Provider *${providerId}* has no bearer-swap rules — ` +
        `it cannot be configured for manual key setup.`,
    );
    return false;
  }

  // Determine credential ID — user picks an existing one or types a new name.
  const credIds = getProviderCredentialIds(providerId, groupScope, tokenEngine);
  const credentialId = await chooseName(
    chat,
    `Set key for *${providerId}*:`,
    [...credIds],
    true,
  );
  if (!credentialId) {
    await chat.send(`Cancelled.`);
    return false;
  }

  // GPG prompt — sends key, instructions, loops until valid input or cancel
  const plaintext = await promptGpgEncrypt(groupScope, chat, AUTH_PROMPT_TIMEOUT, {
    hint: `key for ${providerId} (${credentialId})`,
  });
  if (!plaintext) return false;

  const { needsRestart } = storeProviderKey(
    providerId,
    groupScope,
    credentialId,
    plaintext.trim(),
    0,
    tokenEngine,
  );

  let msg = `Key stored for *${providerId}* (*${credentialId}*).`;
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
    // Show the public key and encryption instructions so the user knows what to do
    if (!isGpgAvailable()) {
      return 'GPG is not available. Install gnupg first.';
    }
    ensureGpgKey(groupScope);
    const pubKey = exportPublicKey(groupScope);
    return (
      pubKey + '\n\n' +
      formatGpgInstructions(pubKey, `your ${providerId} key`) + '\n\n' +
      `Then send:\n` +
      `\`/auth ${providerId} set-key [credential-id] <pgp block>\``
    );
  }

  const pgpBlock = argsAfterSetKey.slice(pgpIdx);
  const prefix = argsAfterSetKey.slice(0, pgpIdx).trim();

  // Parse optional credential ID and expiry from tokens before the PGP block.
  // Any token that isn't `expiry=…` is treated as a credential ID — users can
  // supply arbitrary names, not just pre-existing ones.
  const tokens = prefix.split(/\s+/).filter(Boolean);
  let credentialId: string | undefined;
  let expiry = 0;

  for (const tok of tokens) {
    if (tok.startsWith('expiry=')) {
      const val = parseInt(tok.slice(7), 10);
      if (!isNaN(val)) expiry = val;
    } else if (!credentialId) {
      credentialId = tok;
    }
  }

  // Default credential ID when none was provided
  if (!credentialId) {
    const knownIds = getProviderCredentialIds(
      providerId,
      groupScope,
      tokenEngine,
    );
    credentialId = knownIds.size === 1 ? [...knownIds][0] : CRED_OAUTH;
  }

  // Decrypt
  if (!isGpgAvailable()) {
    return 'GPG is not available. Install gnupg first.';
  }
  ensureGpgKey(groupScope);

  let plaintext: string;
  try {
    plaintext = gpgDecrypt(groupScope, normalizeArmoredBlock(pgpBlock));
  } catch (err) {
    logger.error({ groupScope, err }, 'GPG decrypt failed in set-key');
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
  logger.info(
    { groupScope, providerId, credentialId },
    'Key stored via set-key',
  );
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
