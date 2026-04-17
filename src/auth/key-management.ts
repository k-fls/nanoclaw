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
  gpgDecrypt,
  isPgpMessage,
  normalizeArmoredBlock,
  promptGpgEncrypt,
} from './gpg.js';
import { ENV_NAME_RE, validateEnvVarName } from './docker-env.js';
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
  const ownScope = asCredentialScope(groupScope as string);
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

export async function handleSetKey(
  providerId: string,
  argsAfterSetKey: string,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
  chat: ChatIO,
): Promise<string | null> {
  if (!isKeyEligibleProvider(providerId)) {
    return `Provider *${providerId}* has no bearer-swap rules — cannot store keys.`;
  }

  // Parse optional credential ID and expiry from tokens before the PGP block.
  const pgpIdx = argsAfterSetKey.indexOf(PGP_BEGIN);
  const prefix = pgpIdx >= 0 ? argsAfterSetKey.slice(0, pgpIdx).trim() : argsAfterSetKey.trim();
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

  let plaintext: string;

  if (pgpIdx >= 0 && isPgpMessage(argsAfterSetKey.slice(pgpIdx))) {
    // PGP block provided inline — decrypt directly
    const pgpBlock = argsAfterSetKey.slice(pgpIdx);
    if (!isGpgAvailable()) {
      return 'GPG is not available. Install gnupg first.';
    }
    ensureGpgKey(groupScope);
    try {
      plaintext = gpgDecrypt(groupScope, normalizeArmoredBlock(pgpBlock));
    } catch (err) {
      logger.error({ groupScope, err }, 'GPG decrypt failed in set-key');
      return 'Failed to decrypt PGP message. Make sure you encrypted with the correct public key.';
    }
  } else {
    // No PGP block — fall through to interactive GPG prompt
    const result = await promptGpgEncrypt(groupScope, chat, AUTH_PROMPT_TIMEOUT, {
      hint: `your ${providerId} key`,
    });
    if (!result) return null;
    plaintext = result;
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

// ---------------------------------------------------------------------------
// Import (multi-key PGP block, optional per-line provider prefix)
// ---------------------------------------------------------------------------

export type ProviderEntries = Map<string, Map<string, string>>;
export type TokenizedEntries = Map<string | null, Map<string, string | null>>;

export type ApplyResult = {
  providerId: string;
  count: number;
  envVars: string[];
  warnings: string[];
  needsRestart: boolean;
};

/**
 * Build a reverse index mapping envVarName → list of providers that declare it.
 * Used in bulk import to auto-resolve the provider for un-prefixed ALL_CAPS lines.
 */
export function buildEnvVarProviderIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const id of getAllDiscoveryProviderIds()) {
    const provider = getDiscoveryProvider(id);
    if (!provider?.envVars) continue;
    for (const envName of Object.keys(provider.envVars)) {
      let list = index.get(envName);
      if (!list) {
        list = [];
        index.set(envName, list);
      }
      list.push(id);
    }
  }
  return index;
}

/**
 * Tokenize `[provider:]key=value` lines and group entries by provider prefix.
 * Pure syntactic split — no validation. Lines without a prefix land under the
 * `null` key; lines with no `=` are stored with a null value.
 *
 * A provider prefix is only recognized when ':' appears before the first '='.
 */
export function tokenizeImportLines(plaintext: string): TokenizedEntries {
  const tokenized: TokenizedEntries = new Map();
  for (const raw of plaintext.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    const colonIdx = line.indexOf(':');
    const hasPrefix = colonIdx > 0 && (eqIdx < 0 || colonIdx < eqIdx);
    const providerPrefix = hasPrefix ? line.slice(0, colonIdx).trim() : null;
    const rest = hasPrefix ? line.slice(colonIdx + 1).trim() : line;

    const restEq = rest.indexOf('=');
    const key = restEq >= 0 ? rest.slice(0, restEq).trim() : rest;
    const value = restEq >= 0 ? rest.slice(restEq + 1).trim() : null;

    let entries = tokenized.get(providerPrefix);
    if (!entries) {
      entries = new Map();
      tokenized.set(providerPrefix, entries);
    }
    entries.set(key, value); // last-write-wins for duplicates
  }
  return tokenized;
}

/** Store entries for one provider and register env vars where applicable. */
export function applyProviderEntries(
  providerId: string,
  entries: Map<string, string>,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
): ApplyResult {
  const provider = getDiscoveryProvider(providerId);
  if (!provider) {
    return { providerId, count: 0, envVars: [], warnings: ['unknown provider'], needsRestart: false };
  }
  if (!isKeyEligibleProvider(providerId)) {
    return { providerId, count: 0, envVars: [], warnings: ['no bearer-swap rules'], needsRestart: false };
  }

  // Reverse map: envVarName → credentialPath (e.g. GH_TOKEN → oauth)
  const envToCredPath = new Map(Object.entries(provider.envVars ?? {}));

  const envVars: string[] = [];
  const warnings: string[] = [];
  let count = 0;
  let needsRestart = false;

  for (const [key, value] of entries) {
    const credentialPath = envToCredPath.get(key) ?? key;
    const r = storeProviderKey(providerId, groupScope, credentialPath, value, 0, tokenEngine);
    if (r.needsRestart) needsRestart = true;
    count++;

    if (!ENV_NAME_RE.test(key)) continue;
    const envErr = validateEnvVarName(key);
    if (envErr) {
      warnings.push(`${key}: ${envErr}`);
      continue;
    }
    const sub = tokenEngine.getOrCreateSubstitute(
      providerId, {}, groupScope, provider.substituteConfig, credentialPath, [key],
    );
    if (sub === null) {
      warnings.push(
        `${key}: token too short to substitute safely (len=${value.length}); ` +
          `credential stored but not available to containers. Set _token_format in discovery JSON.`,
      );
      continue;
    }
    envVars.push(key);
  }

  return { providerId, count, envVars, warnings, needsRestart };
}

export function renderSummary(
  results: ApplyResult[],
  isBulk: boolean,
  lineWarnings: string[],
): string {
  const parts: string[] = [];
  const needsRestart = results.some(r => r.needsRestart);

  if (isBulk) {
    const total = results.reduce((s, r) => s + r.count, 0);
    const ok = results.filter(r => r.count > 0).length;
    parts.push(
      `Imported ${total} credential${total !== 1 ? 's' : ''} ` +
        `across ${ok} provider${ok !== 1 ? 's' : ''}.`,
    );
    for (const r of results) {
      const segs = [`*${r.providerId}*: ${r.count} key${r.count !== 1 ? 's' : ''}`];
      if (r.envVars.length) segs.push(`env: ${r.envVars.join(', ')}`);
      if (r.warnings.length) segs.push(`warn: ${r.warnings.join('; ')}`);
      parts.push('  - ' + segs.join(' | '));
    }
  } else {
    const r = results[0];
    parts.push(`Imported ${r.count} credential${r.count !== 1 ? 's' : ''} for *${r.providerId}*.`);
    if (r.envVars.length) parts.push(`Env vars: ${r.envVars.join(', ')}`);
    if (r.warnings.length) {
      parts.push(`Warnings:\n${r.warnings.map(w => `  - ${w}`).join('\n')}`);
    }
  }

  if (lineWarnings.length) {
    parts.push(`Skipped lines:\n${lineWarnings.map(w => `  - ${w}`).join('\n')}`);
  }
  if (needsRestart) {
    parts.push('⚠️ Container restart may be needed for new keys to take effect.');
  }
  return parts.join('\n');
}

/**
 * Decrypt and import a PGP block of `[provider:]key=value` lines.
 *
 * When `defaultProviderId` is set, lines without a prefix are attributed to it
 * (single-provider form). When null, every line must carry a prefix (bulk
 * form). Eligibility and existence checks are done per-provider while applying.
 *
 * Capitalized keys that pass env-var validation are registered as container
 * env vars on the substitute entry (via envNames).
 */
export async function handleImport(
  defaultProviderId: string | null,
  argsAfterImport: string,
  groupScope: GroupScope,
  tokenEngine: TokenSubstituteEngine,
  chat: ChatIO,
): Promise<string | null> {
  // Decrypt — inline PGP block or interactive prompt
  const pgpIdx = argsAfterImport.indexOf(PGP_BEGIN);
  let plaintext: string;

  if (pgpIdx >= 0 && isPgpMessage(argsAfterImport.slice(pgpIdx))) {
    if (!isGpgAvailable()) return 'GPG is not available. Install gnupg first.';
    ensureGpgKey(groupScope);
    try {
      plaintext = gpgDecrypt(groupScope, normalizeArmoredBlock(argsAfterImport.slice(pgpIdx)));
    } catch (err) {
      logger.error({ groupScope, err }, 'GPG decrypt failed in import');
      return 'Failed to decrypt PGP message. Make sure you encrypted with the correct public key.';
    }
  } else {
    const result = await promptGpgEncrypt(groupScope, chat, AUTH_PROMPT_TIMEOUT, {
      hint: defaultProviderId
        ? `key=value pairs for ${defaultProviderId}`
        : 'provider:key=value pairs',
    });
    if (!result) return null;
    plaintext = result;
  }

  // Validate tokenized entries and resolve default provider.
  const tokenized = tokenizeImportLines(plaintext);
  const byProvider: ProviderEntries = new Map();
  const lineWarnings: string[] = [];

  // Only build the reverse index when we may need it (bulk mode).
  const envVarIndex =
    defaultProviderId === null ? buildEnvVarProviderIndex() : null;

  for (const [prefix, entries] of tokenized) {
    // Single-provider mode: ignore lines that target a different provider.
    if (defaultProviderId !== null && prefix !== null && prefix !== defaultProviderId) {
      for (const [key, value] of entries) {
        const label = value === null ? key : `${key}=${value}`;
        lineWarnings.push(`ignored (${prefix} ≠ ${defaultProviderId}): ${label}`);
      }
      continue;
    }

    for (const [key, value] of entries) {
      const label = value === null ? key : `${key}=${value}`;

      // Resolve provider for this line:
      //   1. explicit prefix wins
      //   2. else single-provider default
      //   3. else (bulk mode) try env-var auto-resolution on ALL_CAPS keys
      let providerId = prefix ?? defaultProviderId;
      if (!providerId && envVarIndex && ENV_NAME_RE.test(key)) {
        const candidates = envVarIndex.get(key);
        if (candidates && candidates.length === 1) {
          providerId = candidates[0];
        } else if (candidates && candidates.length > 1) {
          lineWarnings.push(
            `ambiguous env var ${key}: matches [${candidates.join(', ')}] — prefix with 'provider:'`,
          );
          continue;
        }
      }

      if (!providerId) {
        lineWarnings.push(`no provider: ${label}`);
        continue;
      }
      if (!key || value === null) {
        lineWarnings.push(`malformed: ${label}`);
        continue;
      }
      if (!value) {
        lineWarnings.push(`empty value: ${key}`);
        continue;
      }
      let target = byProvider.get(providerId);
      if (!target) {
        target = new Map();
        byProvider.set(providerId, target);
      }
      target.set(key, value);
    }
  }

  const isBulk = defaultProviderId === null;

  if (byProvider.size === 0) {
    const base = isBulk
      ? 'No valid provider:key=value pairs found in decrypted message.'
      : 'No valid KEY=VALUE pairs found in decrypted message.';
    return lineWarnings.length
      ? `${base}\nSkipped lines:\n${lineWarnings.map(w => `  - ${w}`).join('\n')}`
      : base;
  }

  const results = [...byProvider].map(([id, entries]) =>
    applyProviderEntries(id, entries, groupScope, tokenEngine),
  );

  logger.info(
    {
      groupScope,
      defaultProviderId,
      results: results.map(r => ({ id: r.providerId, count: r.count })),
    },
    'Credentials imported',
  );
  return renderSummary(results, isBulk, lineWarnings);
}
