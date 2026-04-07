/**
 * Format-preserving token substitute engine.
 *
 * Generates substitute tokens that look like the real ones (same prefix,
 * suffix, delimiter positions, character classes) but with randomized
 * middle sections. Containers never see real tokens — only substitutes.
 *
 * The engine does NOT store credentials. It stores ProviderSubstitutes
 * (per-provider grouping with optional sourceScope for cross-scope
 * borrowing) and delegates real-token storage/retrieval to a pluggable
 * TokenResolver.
 *
 * Internal structure:
 *   scopes: Map<GroupScope, Map<providerId, ProviderSubstitutes>>
 *   subToProvider: Map<substitute, { groupScope, providerId }>  (reverse index)
 *
 * Callers always pass GroupScope (= group.folder). The engine internally
 * resolves CredentialScope using group flags + provider checks.
 */
import { randomInt } from 'crypto';
import fs from 'fs';
import path from 'path';

import type {
  SubstituteConfig,
  SubstituteMapping,
  SubstituteEntry,
  ProviderSubstitutes,
  ScopeAccessCheck,
  TokenResolver,
  GroupScope,
  CredentialScope,
} from './oauth-types.js';
import {
  MIN_RANDOM_CHARS,
  DEFAULT_CREDENTIAL_SCOPE,
  asGroupScope,
  asCredentialScope,
} from './oauth-types.js';

/**
 * Use a group's own folder as a credential scope.
 * Internal to the engine — callers should use resolveCredentialScope() instead.
 */
function toCredentialScope(groupScope: GroupScope): CredentialScope {
  return groupScope as unknown as CredentialScope;
}
import { encrypt, decrypt, CREDENTIALS_DIR } from './store.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Character class helpers
// ---------------------------------------------------------------------------

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';
const ALNUM = LOWER + UPPER + DIGIT;

function randomCharSameClass(ch: string, delimiters: string): string {
  if (delimiters.includes(ch)) return ch;
  if (LOWER.includes(ch)) return LOWER[randomInt(LOWER.length)];
  if (UPPER.includes(ch)) return UPPER[randomInt(UPPER.length)];
  if (DIGIT.includes(ch)) return DIGIT[randomInt(DIGIT.length)];
  return ALNUM[randomInt(ALNUM.length)];
}

// ---------------------------------------------------------------------------
// Default in-memory token resolver
// ---------------------------------------------------------------------------

/**
 * @deprecated Use credentialPath (free-form string) instead.
 * Kept temporarily so external callers compile during migration.
 */
export type TokenRole = string;

// ---------------------------------------------------------------------------
// Credential path helpers
// ---------------------------------------------------------------------------

/**
 * Parse a credentialPath into its identity (top-level key) and optional
 * nested sub-token name.
 *   'oauth'         → { id: 'oauth' }
 *   'oauth/refresh' → { id: 'oauth', nested: 'refresh' }
 */
function parsePath(credentialPath: string): { id: string; nested?: string } {
  const slash = credentialPath.indexOf('/');
  if (slash === -1) return { id: credentialPath };
  return { id: credentialPath.slice(0, slash), nested: credentialPath.slice(slash + 1) };
}

/** Cache key for in-memory hot tokens. */
function cacheKey(
  credentialScope: CredentialScope,
  providerId: string,
  credentialPath: string,
): string {
  return `${credentialScope}\0${providerId}\0${credentialPath}`;
}

// ---------------------------------------------------------------------------
// Locked JSON file helpers — fd held open between read and write
// ---------------------------------------------------------------------------

/**
 * Read a JSON file, returning empty object on ENOENT. Throws on other errors.
 */
function readJsonFile<T extends object>(filePath: string): T {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {} as T;
    throw err;
  }
  if (!content.trim()) return {} as T;
  return JSON.parse(content) as T;
}

/**
 * Atomic read-modify-write of a JSON file.
 * Holds the fd open between read and write to prevent partial reads.
 * Note: no advisory lock (flock) — safe within single-threaded Node
 * but not across multiple NanoClaw processes.
 */
function updateJsonFile<T extends object>(
  filePath: string,
  update: (data: T) => void,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let fd: number;
  let data = {} as T;

  try {
    fd = fs.openSync(filePath, 'r+');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT,
      0o600,
    );
  }

  try {
    const content = fs.readFileSync(fd, 'utf-8');
    if (content.trim()) data = JSON.parse(content);
  } catch (err: any) {
    // EBADF = opened write-only (new file) — data stays {}
    if (err.code !== 'EBADF') {
      fs.closeSync(fd);
      throw err;
    }
  }

  try {
    update(data);

    const buf = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Keys file: credentials/{credentialScope}/{providerId}.keys.json
// All roles for one provider in one file. No plaintext secrets.
// ---------------------------------------------------------------------------

export interface AuthToken {
  value: string; // encrypted token
  expires_ts: number; // epoch ms, 0 = no expiry
  authFields?: Record<string, string>; // captured fields for refresh (client_id, scope, etc.)
}

/** A stored credential with optional nested refresh token. */
export interface Credential extends AuthToken {
  updated_ts: number; // epoch ms
  /** Nested refresh token — only present for OAuth credentials. */
  refresh?: {
    value: string; // encrypted
    expires_ts: number;
    updated_ts: number;
  };
}

/** @deprecated Alias for Credential during migration. */
export type KeyEntry = Credential;

/** Keys file format: credentialId → Credential. V3 includes a version marker. */
export type KeysFile = Record<string, Credential> & { v?: number };

export function keysPath(
  credentialScope: CredentialScope,
  providerId: string,
): string {
  return path.join(CREDENTIALS_DIR, credentialScope, `${providerId}.keys.json`);
}

/** Current keys file version. */
const KEYS_FILE_VERSION = 3;

/**
 * Legacy credential ID mapping: old role names → new credential IDs.
 * Applied during migration of pre-V3 keys files.
 */
const LEGACY_ROLE_MAP: Record<string, string> = {
  access: 'oauth',
};

export function readKeysFile(
  credentialScope: CredentialScope,
  providerId: string,
): KeysFile {
  const keys = readJsonFile<KeysFile>(keysPath(credentialScope, providerId));
  if (keys.v && keys.v >= KEYS_FILE_VERSION) return keys;
  return migrateKeysFile(keys, credentialScope, providerId);
}

/**
 * Migrate a pre-V3 keys file:
 * 1. Move sibling 'refresh' into its parent credential's .refresh field
 * 2. Rename 'access' → 'oauth'
 * Writes back to disk so migration only runs once.
 */
function migrateKeysFile(
  keys: KeysFile,
  credentialScope: CredentialScope,
  providerId: string,
): KeysFile {
  const refreshEntry = keys['refresh'];
  const hasLegacy =
    refreshEntry || keys['access'] || !keys.v;

  if (!hasLegacy && Object.keys(keys).length === 0) return keys;

  // Move sibling 'refresh' into its parent
  if (refreshEntry) {
    // Find parent: 'access' (or 'oauth' if already renamed)
    const parentId = keys['access'] ? 'access' : keys['oauth'] ? 'oauth' : null;
    if (parentId) {
      keys[parentId].refresh = {
        value: refreshEntry.value,
        expires_ts: refreshEntry.expires_ts,
        updated_ts: refreshEntry.updated_ts,
      };
      // Copy authFields from refresh to parent if parent lacks them
      if (refreshEntry.authFields && !keys[parentId].authFields) {
        keys[parentId].authFields = refreshEntry.authFields;
      }
    }
    delete keys['refresh'];
  }

  // Rename 'access' → 'oauth'
  if (keys['access']) {
    keys['oauth'] = keys['access'];
    delete keys['access'];
  }

  keys.v = KEYS_FILE_VERSION;

  // Persist migration
  try {
    writeKeysFile(credentialScope, providerId, keys);
  } catch {
    /* best effort */
  }

  return keys;
}

export function writeKeysFile(
  credentialScope: CredentialScope,
  providerId: string,
  keys: KeysFile,
): void {
  keys.v = KEYS_FILE_VERSION;
  const p = keysPath(credentialScope, providerId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Refs file: credentials/{groupScope}/{providerId}.refs.json
// Per-provider substitute mappings with optional sourceScope. No secrets.
// ---------------------------------------------------------------------------

/** V2 refs file format (legacy). */
interface RefsFileV2 {
  sourceScope?: string;
  substitutes: Record<
    string,
    { role: string; scopeAttrs: Record<string, string> }
  >;
}

/** V3 refs file format. */
interface RefsFileV3 {
  v: 3;
  sourceScope?: string;
  substitutes: Record<
    string,
    { credentialPath: string; scopeAttrs: Record<string, string> }
  >;
}

function refsPath(groupScope: GroupScope, providerId: string): string {
  return path.join(CREDENTIALS_DIR, groupScope, `${providerId}.refs.json`);
}

// ---------------------------------------------------------------------------
// Persistent token resolver — keyed by (CredentialScope, providerId, role)
// ---------------------------------------------------------------------------

/**
 * Persistent token resolver.
 *
 * Caches whole Credential objects in memory, indexed by
 * (credentialScope, providerId, credentialId). The cache holds decrypted
 * token values and expiry for the hot path. Nested sub-tokens (e.g.
 * refresh) live on the cached Credential object.
 *
 * Keys file: credentials/{credentialScope}/{providerId}.keys.json
 *   { credentialId: { value: encrypted, updated_ts, expires_ts, refresh?: {...} } }
 */
export class PersistentTokenResolver implements TokenResolver {
  /**
   * Hot cache: cacheKey(scope, provider, credentialId) → decrypted Credential.
   * Token values in cached entries are decrypted (not encrypted like on disk).
   */
  private cache = new Map<string, Credential>();

  store(
    realToken: string,
    providerId: string,
    credentialScope: CredentialScope,
    credentialPath: string = 'oauth',
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): void {
    this.persistToKeys(
      credentialScope,
      providerId,
      credentialPath,
      realToken,
      expiresTs,
      authFields,
    );
    // Update cache — only for top-level credentials, not nested sub-tokens
    const { nested } = parsePath(credentialPath);
    if (!nested) {
      const ck = cacheKey(credentialScope, providerId, credentialPath);
      this.cache.set(ck, {
        value: realToken,
        expires_ts: expiresTs,
        updated_ts: Date.now(),
        ...(authFields && { authFields }),
      });
    }
  }

  resolve(
    credentialScope: CredentialScope,
    providerId: string,
    credentialPath: string,
  ): string | null {
    const { id, nested } = parsePath(credentialPath);

    if (nested) {
      // Nested sub-tokens (e.g. oauth/refresh) are cold — always read from disk
      try {
        const keys = readKeysFile(credentialScope, providerId);
        const entry = keys[id];
        if (!entry) return null;
        const sub = (entry as unknown as Record<string, unknown>)[nested];
        if (!sub || typeof sub !== 'object' || !('value' in sub)) return null;
        return decrypt((sub as { value: string }).value);
      } catch {
        return null;
      }
    }

    // Top-level: use cache
    const ck = cacheKey(credentialScope, providerId, id);
    if (!this.cache.has(ck)) {
      try {
        this.warmCache(credentialScope, providerId, id);
      } catch {
        /* encryption not initialized or file not found */
      }
    }
    const cached = this.cache.get(ck);
    return cached?.value || null;
  }

  /** Update a real token in place (e.g. after refresh). */
  update(
    credentialScope: CredentialScope,
    providerId: string,
    credentialPath: string,
    newRealToken: string,
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): void {
    this.persistToKeys(
      credentialScope,
      providerId,
      credentialPath,
      newRealToken,
      expiresTs,
      authFields,
    );
    // Update cache — only for top-level credentials, not nested sub-tokens
    const { nested } = parsePath(credentialPath);
    if (!nested) {
      const ck = cacheKey(credentialScope, providerId, credentialPath);
      const cached = this.cache.get(ck);
      if (cached) {
        cached.value = newRealToken;
        cached.expires_ts = expiresTs;
        cached.updated_ts = Date.now();
        if (authFields) cached.authFields = authFields;
      } else {
        this.cache.set(ck, {
          value: newRealToken,
          expires_ts: expiresTs,
          updated_ts: Date.now(),
          ...(authFields && { authFields }),
        });
      }
    }
  }

  revoke(credentialScope: CredentialScope, providerId?: string): void {
    const prefix = credentialScope + '\0' + (providerId ?? '');
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Load a credential from disk and populate the cache.
   * Called on cold-path cache miss.
   * Note: refresh sub-tokens are NOT cached — they're read from disk on demand.
   */
  private warmCache(
    credentialScope: CredentialScope,
    providerId: string,
    credentialId: string,
  ): void {
    const keys = readKeysFile(credentialScope, providerId);
    const entry = keys[credentialId];
    if (!entry) return;
    const ck = cacheKey(credentialScope, providerId, credentialId);
    this.cache.set(ck, {
      value: entry.value ? decrypt(entry.value) : '',
      expires_ts: entry.expires_ts,
      updated_ts: entry.updated_ts,
      ...(entry.authFields && { authFields: entry.authFields }),
      // refresh intentionally omitted — cold path, disk only
    });
  }

  /** Delete the on-disk keys file for a (scope, provider). */
  deleteKeys(credentialScope: CredentialScope, providerId: string): void {
    try {
      fs.unlinkSync(keysPath(credentialScope, providerId));
    } catch {
      /* already gone */
    }
  }

  /** Number of cached credentials (for testing). */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Read the full Credential for a credentialPath.
   * Checks cache first, falls back to disk.
   * For nested paths ('oauth/refresh'), returns a synthetic Credential
   * wrapping the nested sub-token.
   */
  resolveCredential(
    credentialScope: CredentialScope,
    providerId: string,
    credentialPath: string,
  ): Credential | null {
    const { id, nested } = parsePath(credentialPath);

    if (nested) {
      // Nested sub-tokens are always read from disk (cold path)
      const keys = readKeysFile(credentialScope, providerId);
      const entry = keys[id];
      if (!entry) return null;
      const sub = (entry as unknown as Record<string, unknown>)[nested];
      if (!sub || typeof sub !== 'object') return null;
      const subToken = sub as { value: string; expires_ts: number; updated_ts: number };
      return {
        value: subToken.value,
        expires_ts: subToken.expires_ts,
        updated_ts: subToken.updated_ts,
        authFields: entry.authFields,
      };
    }

    // Top-level: use cache
    const ck = cacheKey(credentialScope, providerId, id);
    if (!this.cache.has(ck)) {
      this.warmCache(credentialScope, providerId, id);
    }
    return this.cache.get(ck) ?? null;
  }

  /** @deprecated Alias for resolveCredential. */
  resolveKeyEntry(
    credentialScope: CredentialScope,
    providerId: string,
    credentialPath: string,
  ): Credential | null {
    return this.resolveCredential(credentialScope, providerId, credentialPath);
  }

  /**
   * Locked read-merge-write one credential path into the provider's keys file.
   * Handles both top-level ('oauth') and nested ('oauth/refresh') paths.
   */
  private persistToKeys(
    credentialScope: CredentialScope,
    providerId: string,
    credentialPath: string,
    realToken: string,
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): boolean {
    const { id, nested } = parsePath(credentialPath);
    try {
      updateJsonFile<KeysFile>(
        keysPath(credentialScope, providerId),
        (keys) => {
          if (nested) {
            // Nested path (e.g. 'oauth/refresh') — write sub-token
            if (!keys[id]) {
              keys[id] = { value: '', updated_ts: Date.now(), expires_ts: 0 };
            }
            (keys[id] as unknown as Record<string, unknown>)[nested] = {
              value: encrypt(realToken),
              expires_ts: expiresTs,
              updated_ts: Date.now(),
            };
          } else {
            // Top-level path — write credential, preserve nested sub-tokens
            const existing = keys[id];
            keys[id] = {
              value: encrypt(realToken),
              updated_ts: Date.now(),
              expires_ts: expiresTs,
              ...(authFields && { authFields }),
              ...(existing?.refresh && { refresh: existing.refresh }),
            };
          }
          keys.v = KEYS_FILE_VERSION;
        },
      );
      return true;
    } catch (err) {
      logger.warn(
        { err, credentialScope, providerId, credentialPath },
        'Token persistence failed',
      );
      return false;
    }
  }

}

// ---------------------------------------------------------------------------
// Token Substitute Engine
// ---------------------------------------------------------------------------

/** Result of resolving a substitute: the real token + mapping metadata. */
export interface ResolvedToken {
  realToken: string;
  mapping: SubstituteMapping;
}

/** Callback to look up a RegisteredGroup by folder name. */
export type GroupResolver = (
  groupScope: GroupScope,
) => RegisteredGroup | undefined;

export class TokenSubstituteEngine {
  /**
   * Two-level lookup: GroupScope → providerId → ProviderSubstitutes.
   * Each group's substitutes are isolated. Per-provider grouping enables
   * efficient ownership takeover and access revocation.
   */
  private scopes = new Map<GroupScope, Map<string, ProviderSubstitutes>>();

  /** Reverse index: substitute string → { groupScope, providerId }. O(1) lookup on hot path. */
  private subToProvider = new Map<
    string,
    { groupScope: GroupScope; providerId: string }
  >();

  private accessCheck: ScopeAccessCheck | null = null;
  private groupResolver: GroupResolver | null = null;

  /** In-flight async operations keyed by (credentialScope, providerId, op). */
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private resolver: TokenResolver) {}

  // ── Configuration setters (called once at startup) ───────────────

  /** Set the access check callback. */
  setAccessCheck(check: ScopeAccessCheck): void {
    this.accessCheck = check;
  }

  /** Set the group resolver (avoids circular deps with group registry). */
  setGroupResolver(resolver: GroupResolver): void {
    this.groupResolver = resolver;
  }

  // ── Concurrency ─────────────────────────────────────────────────

  /**
   * Run an async operation at most once per (credentialScope, providerId, op) key.
   * Concurrent callers for the same key share the result of the first caller.
   * Resolves groupScope → credentialScope internally so two groups borrowing
   * from the same scope coalesce automatically.
   */
  sharedOp<T>(
    groupScope: GroupScope,
    providerId: string,
    op: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const credScope = this.resolveCredentialScope(groupScope, providerId);
    const key = `${credScope}\0${providerId}\0${op}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p as Promise<unknown>);
    return p;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /** Access the underlying token resolver (e.g. for legacy refresh operations). */
  getResolver(): TokenResolver {
    return this.resolver;
  }

  /** Get or create the provider map for a group scope. */
  private providerMap(
    groupScope: GroupScope,
  ): Map<string, ProviderSubstitutes> {
    let map = this.scopes.get(groupScope);
    if (!map) {
      map = new Map();
      this.scopes.set(groupScope, map);
    }
    return map;
  }

  /** Get or create ProviderSubstitutes for a (group, provider) pair. */
  private getOrCreateProvSubs(
    groupScope: GroupScope,
    providerId: string,
    sourceScope?: CredentialScope,
  ): ProviderSubstitutes {
    const pmap = this.providerMap(groupScope);
    let ps = pmap.get(providerId);
    if (!ps) {
      ps = { sourceScope, substitutes: new Map() };
      pmap.set(providerId, ps);
    }
    return ps;
  }

  /** Insert a substitute into both forward and reverse maps. */
  private insertSub(
    groupScope: GroupScope,
    providerId: string,
    substitute: string,
    entry: SubstituteEntry,
    sourceScope?: CredentialScope,
  ): void {
    const ps = this.getOrCreateProvSubs(groupScope, providerId, sourceScope);
    ps.substitutes.set(substitute, entry);
    this.subToProvider.set(substitute, { groupScope, providerId });
  }

  /** Remove a substitute from both forward and reverse maps. */
  private removeSub(
    groupScope: GroupScope,
    providerId: string,
    substitute: string,
  ): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (ps) ps.substitutes.delete(substitute);
    this.subToProvider.delete(substitute);
  }

  /**
   * Resolve where credentials live for a (group, provider) pair.
   * Returns the credential scope and whether the group can modify it
   * (owns it or is main managing default).
   */
  private resolveCredentialScopeInternal(
    groupScope: GroupScope,
    providerId: string,
    defaultScope: CredentialScope = DEFAULT_CREDENTIAL_SCOPE,
  ): { scope: CredentialScope; writable: boolean } {
    const ownScope = toCredentialScope(groupScope);
    const group = this.groupResolver?.(groupScope);
    if (!group) return { scope: ownScope, writable: true };
    const useDefault =
      group.containerConfig?.useDefaultCredentials ?? group.isMain === true;
    // Main + default: main manages default directly
    if (group.isMain && useDefault)
      return { scope: defaultScope, writable: true };
    // Check own scope first
    if (this.hasKeysInScope(ownScope, providerId))
      return { scope: ownScope, writable: true };
    // Fall back to default if allowed — read-only (non-main borrowing)
    if (useDefault && this.hasKeysInScope(defaultScope, providerId))
      return { scope: defaultScope, writable: false };
    return { scope: ownScope, writable: true };
  }

  /** Resolve where credentials live for a (group, provider) pair. */
  resolveCredentialScope(
    groupScope: GroupScope,
    providerId: string,
  ): CredentialScope {
    return this.resolveCredentialScopeInternal(groupScope, providerId).scope;
  }

  /** Effective credential scope: sourceScope if borrowed, groupScope if own. */
  private effectiveScope(
    groupScope: GroupScope,
    ps: ProviderSubstitutes,
  ): CredentialScope {
    return ps.sourceScope ?? toCredentialScope(groupScope);
  }

  // ── Public query methods ─────────────────────────────────────────

  /**
   * Get existing substitute for (providerId, groupScope, credentialPath).
   * Returns null if none exists. When multiple exist (from token refreshes),
   * returns the first when sorted — stable and deterministic.
   */
  getSubstitute(
    providerId: string,
    groupScope: GroupScope,
    credentialPath: string = 'oauth',
  ): string | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return null;
    const matches: string[] = [];
    for (const [sub, entry] of ps.substitutes) {
      if (entry.credentialPath === credentialPath) matches.push(sub);
    }
    if (matches.length === 0) return null;
    return matches.sort()[0];
  }

  /**
   * Get existing substitute, or generate one from the resolver's keys file.
   * Used by providers at container startup — never needs a real token arg.
   *
   * The engine resolves the credential source scope internally using
   * the group's flags and the provider's hasValidCredentials().
   */
  getOrCreateSubstitute(
    providerId: string,
    scopeAttrs: Record<string, string>,
    groupScope: GroupScope,
    config: SubstituteConfig,
    credentialPath: string = 'oauth',
  ): string | null {
    const existing = this.getSubstitute(providerId, groupScope, credentialPath);
    if (existing) return existing;

    // Resolve which scope holds the real credentials
    const credScope = this.resolveCredentialScope(groupScope, providerId);
    const ownCredScope = toCredentialScope(groupScope);
    const sourceScope = credScope !== ownCredScope ? credScope : undefined;

    const realToken = this.resolver.resolve(credScope, providerId, credentialPath);
    if (!realToken) return null;

    return this.generateSubstitute(
      realToken,
      providerId,
      scopeAttrs,
      groupScope,
      config,
      credentialPath,
      sourceScope,
    );
  }

  /**
   * Generate a format-preserving substitute for a real token.
   *
   * Stores the real token via the TokenResolver (under the effective scope)
   * and records the mapping. Returns null if the token is too short to
   * safely randomize.
   *
   * @param sourceScope — if set, credentials are borrowed from this scope.
   *   Omit for owned credentials.
   */
  generateSubstitute(
    realToken: string,
    providerId: string,
    scopeAttrs: Record<string, string>,
    groupScope: GroupScope,
    config: SubstituteConfig,
    credentialPath: string = 'oauth',
    sourceScope?: CredentialScope,
    authFields?: Record<string, string>,
  ): string | null {
    const { prefixLen, suffixLen, delimiters } = config;

    if (realToken.length <= prefixLen + suffixLen) {
      return null;
    }

    const prefix = realToken.slice(0, prefixLen);
    const suffix = suffixLen > 0 ? realToken.slice(-suffixLen) : '';
    const middle =
      suffixLen > 0
        ? realToken.slice(prefixLen, -suffixLen)
        : realToken.slice(prefixLen);

    let randomizable = 0;
    for (const ch of middle) {
      if (!delimiters.includes(ch)) randomizable++;
    }

    if (randomizable < MIN_RANDOM_CHARS) {
      return null;
    }

    // Check for collision against all substitutes in this group scope
    const pmap = this.providerMap(groupScope);

    for (let attempt = 0; attempt < 3; attempt++) {
      const randomizedMiddle = Array.from(middle)
        .map((ch) => randomCharSameClass(ch, delimiters))
        .join('');

      const substitute = prefix + randomizedMiddle + suffix;

      if (substitute === realToken) continue;
      if (this.subToProvider.has(substitute)) continue;

      // Persist real token via resolver (under the effective credential scope)
      const effCredScope: CredentialScope =
        sourceScope ?? toCredentialScope(groupScope);
      this.resolver.store(
        realToken,
        providerId,
        effCredScope,
        credentialPath,
        0,
        authFields,
      );

      // Store in the engine
      const entry: SubstituteEntry = { credentialPath, scopeAttrs };
      this.insertSub(groupScope, providerId, substitute, entry, sourceScope);

      // Persist substitute → role mapping (no secrets)
      this.persistRefs(groupScope, providerId);

      return substitute;
    }

    return null;
  }

  /**
   * Resolve a substitute to the real token + metadata.
   * Returns null if unknown substitute, access denied, or resolver can't find the token.
   *
   * If the substitute belongs to a borrowed provider and the access check
   * denies access, the substitute is revoked and null is returned.
   */
  resolveSubstitute(
    substitute: string,
    groupScope: GroupScope,
  ): ResolvedToken | null {
    const ref = this.subToProvider.get(substitute);
    if (!ref || ref.groupScope !== groupScope) return null;

    const ps = this.scopes.get(groupScope)?.get(ref.providerId);
    if (!ps) return null;

    const entry = ps.substitutes.get(substitute);
    if (!entry) return null;

    // Access check for borrowed credentials
    if (ps.sourceScope && this.accessCheck) {
      if (!this.accessCheck(groupScope, ps.sourceScope)) {
        // Revoke all substitutes for this borrowed provider
        this.revokeProvider(groupScope, ref.providerId);
        return null;
      }
    }

    const effCredScope = this.effectiveScope(groupScope, ps);
    const realToken = this.resolver.resolve(
      effCredScope,
      ref.providerId,
      entry.credentialPath,
    );
    if (!realToken) return null;

    return {
      realToken,
      mapping: {
        providerId: ref.providerId,
        credentialPath: entry.credentialPath,
        scopeAttrs: entry.scopeAttrs,
        credentialScope: effCredScope,
      },
    };
  }

  /**
   * Resolve with scope attribute restriction.
   */
  resolveWithRestriction(
    substitute: string,
    groupScope: GroupScope,
    requiredAttrs: Record<string, string>,
  ): ResolvedToken | null {
    const resolved = this.resolveSubstitute(substitute, groupScope);
    if (!resolved) return null;

    const requiredKeys = Object.keys(requiredAttrs);
    if (requiredKeys.length === 0) return resolved;

    for (const key of requiredKeys) {
      const entryVal = resolved.mapping.scopeAttrs[key];
      if (entryVal !== undefined && entryVal !== requiredAttrs[key]) {
        return null;
      }
    }

    return resolved;
  }

  // ── Credential operations ────────────────────────────────────────

  /**
   * Resolve a real token for a (group, provider, credentialPath) without
   * going through a substitute. Used by refresh flows that need the real
   * refresh token to call a token endpoint.
   *
   * Handles sourceScope indirection internally.
   */
  resolveRealToken(
    groupScope: GroupScope,
    providerId: string,
    credentialPath: string,
  ): string | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    return this.resolver.resolve(effCredScope, providerId, credentialPath);
  }

  /** Get the full Credential for a credentialPath, resolving source scope. */
  getKeyEntry(
    groupScope: GroupScope,
    providerId: string,
    credentialPath: string,
  ): Credential | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    return (this.resolver as PersistentTokenResolver).resolveCredential(
      effCredScope,
      providerId,
      credentialPath,
    );
  }

  /**
   * Get the expiry timestamp for a credential path, resolving source scope.
   * Returns 0 if not found or no expiry set.
   */
  getKeyExpiry(
    groupScope: GroupScope,
    providerId: string,
    credentialPath: string,
  ): number {
    const entry = this.getKeyEntry(groupScope, providerId, credentialPath);
    return entry?.expires_ts ?? 0;
  }

  /**
   * Refresh a credential. Writes to the source scope if borrowed and
   * access is still allowed. If access is denied, promotes to own scope.
   */
  refreshCredential(
    groupScope: GroupScope,
    providerId: string,
    credentialPath: string,
    newToken: string,
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const ownScope = toCredentialScope(groupScope);
    if (!ps) {
      (this.resolver as PersistentTokenResolver).update(
        ownScope,
        providerId,
        credentialPath,
        newToken,
        expiresTs,
        authFields,
      );
      return;
    }

    if (ps.sourceScope) {
      if (this.accessCheck && !this.accessCheck(groupScope, ps.sourceScope)) {
        (this.resolver as PersistentTokenResolver).update(
          ownScope,
          providerId,
          credentialPath,
          newToken,
          expiresTs,
          authFields,
        );
        ps.sourceScope = undefined;
        this.persistRefs(groupScope, providerId);
        logger.info(
          { groupScope, providerId },
          'Credential promoted to own scope (access revoked on refresh)',
        );
        return;
      }
      (this.resolver as PersistentTokenResolver).update(
        ps.sourceScope,
        providerId,
        credentialPath,
        newToken,
        expiresTs,
        authFields,
      );
    } else {
      (this.resolver as PersistentTokenResolver).update(
        ownScope,
        providerId,
        credentialPath,
        newToken,
        expiresTs,
        authFields,
      );
    }
  }

  /**
   * Add or update a credential for a group. Always writes to the group's
   * own scope. If the provider currently has borrowed substitutes, they
   * are all removed first (ownership takeover).
   */
  addOrUpdateCredential(
    groupScope: GroupScope,
    providerId: string,
    credentialPath: string,
    newToken: string,
    config: SubstituteConfig,
    scopeAttrs: Record<string, string> = {},
    expiresTs = 0,
  ): string | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);

    // Ownership takeover: remove borrowed substitutes
    if (ps?.sourceScope) {
      this.revokeProvider(groupScope, providerId);
    }

    // Store the real token in the group's own scope
    (this.resolver as PersistentTokenResolver).update(
      toCredentialScope(groupScope),
      providerId,
      credentialPath,
      newToken,
      expiresTs,
    );

    // Generate a new substitute (no sourceScope = owned)
    return this.generateSubstitute(
      newToken,
      providerId,
      scopeAttrs,
      groupScope,
      config,
      credentialPath,
    );
  }

  /**
   * Check if any credential role (access, api_key) exists for a provider
   * in the resolved credential scope. When nonExpired is true, also checks
   * expires_ts — rejects tokens past expiry.
   */
  hasAnyCredential(
    groupScope: GroupScope,
    providerId: string,
    nonExpired = false,
  ): boolean {
    const credScope = this.resolveCredentialScope(groupScope, providerId);
    return this.hasKeysInScope(credScope, providerId, nonExpired);
  }

  /**
   * Raw check: does this credential scope have stored keys for the provider?
   * No scope resolution — takes CredentialScope directly.
   * Checks all top-level credentials (skips version marker).
   */
  private hasKeysInScope(
    credentialScope: CredentialScope,
    providerId: string,
    nonExpired = false,
  ): boolean {
    const keys = readKeysFile(credentialScope, providerId);
    for (const [id, entry] of Object.entries(keys)) {
      if (id === 'v') continue;
      if (!entry || typeof entry !== 'object' || !('value' in entry)) continue;
      const cred = entry as Credential;
      if (nonExpired && cred.expires_ts > 0 && cred.expires_ts < Date.now())
        continue;
      return true;
    }
    return false;
  }

  // ── Revocation ───────────────────────────────────────────────────

  /** Revoke all substitutes for a single provider within a group scope. */
  private revokeProvider(groupScope: GroupScope, providerId: string): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return;

    for (const sub of ps.substitutes.keys()) {
      this.subToProvider.delete(sub);
    }

    this.scopes.get(groupScope)!.delete(providerId);
    if (this.scopes.get(groupScope)!.size === 0) this.scopes.delete(groupScope);

    // Don't revoke from resolver if borrowed (those tokens belong to the source scope)
    if (!ps.sourceScope) {
      this.resolver.revoke(toCredentialScope(groupScope), providerId);
    }

    this.deleteRefs(groupScope, providerId);
  }

  /**
   * Revoke substitutes for a group scope (and optionally a provider).
   * Always removes substitutes from the group's own maps.
   * Only deletes keys files if the group owns the credential scope
   * (own scope, or main managing default). Non-main groups borrowing
   * from default never have their keys deleted.
   */
  revokeByScope(groupScope: GroupScope, providerId?: string): number {
    if (providerId) {
      const ps = this.scopes.get(groupScope)?.get(providerId);
      if (!ps) return 0;
      const count = ps.substitutes.size;
      this.revokeProvider(groupScope, providerId);
      const { scope: credScope, writable } =
        this.resolveCredentialScopeInternal(groupScope, providerId);
      if (writable) {
        this.resolver.revoke(credScope, providerId);
        (this.resolver as PersistentTokenResolver).deleteKeys(
          credScope,
          providerId,
        );
      }
      return count;
    }

    const pmap = this.scopes.get(groupScope);
    if (!pmap) return 0;

    let count = 0;
    for (const [pid, ps] of pmap) {
      for (const sub of ps.substitutes.keys()) {
        this.subToProvider.delete(sub);
      }
      count += ps.substitutes.size;
      this.deleteRefs(groupScope, pid);
      const { scope: credScope, writable } =
        this.resolveCredentialScopeInternal(groupScope, pid);
      if (writable) {
        this.resolver.revoke(credScope, pid);
        (this.resolver as PersistentTokenResolver).deleteKeys(credScope, pid);
      }
    }
    this.scopes.delete(groupScope);
    return count;
  }

  /**
   * Clear stored credentials (hot cache + keys file) without removing
   * substitute mappings from engine memory. Running containers keep their
   * substitute → role refs intact. Use pruneStaleRefs() afterward to remove
   * orphaned refs for roles that no longer have keys.
   */
  clearCredentials(groupScope: GroupScope, providerId: string): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    this.resolver.revoke(effCredScope, providerId);
    (this.resolver as PersistentTokenResolver).deleteKeys(
      effCredScope,
      providerId,
    );
  }

  /**
   * Remove substitute refs whose role no longer has a matching key in the resolver.
   * Called after credential mode changes (e.g. OAuth → API key) to clean up
   * orphaned refs while keeping refs for roles that still have keys.
   */
  pruneStaleRefs(groupScope: GroupScope, providerId: string): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return;

    const effCredScope = this.effectiveScope(groupScope, ps);
    const toRemove: string[] = [];

    for (const [sub, entry] of ps.substitutes) {
      const realToken = this.resolver.resolve(
        effCredScope,
        providerId,
        entry.credentialPath,
      );
      if (!realToken) toRemove.push(sub);
    }

    for (const sub of toRemove) {
      ps.substitutes.delete(sub);
      this.subToProvider.delete(sub);
    }

    if (ps.substitutes.size === 0) {
      this.scopes.get(groupScope)?.delete(providerId);
      if (this.scopes.get(groupScope)?.size === 0)
        this.scopes.delete(groupScope);
      this.deleteRefs(groupScope, providerId);
    } else {
      this.persistRefs(groupScope, providerId);
    }
  }

  // ── Metrics ──────────────────────────────────────────────────────

  /** Number of active substitutes across all scopes. */
  get size(): number {
    return this.subToProvider.size;
  }

  /** Number of active scopes. */
  get scopeCount(): number {
    return this.scopes.size;
  }

  // ── Refs persistence ─────────────────────────────────────────────

  /**
   * Persist all substitutes for a (scope, provider) to the refs file.
   * Writes the full file each time (not incremental).
   */
  private persistRefs(groupScope: GroupScope, providerId: string): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return;

    const data: RefsFileV3 = {
      v: 3,
      substitutes: {},
    };
    if (ps.sourceScope) data.sourceScope = ps.sourceScope;
    for (const [sub, entry] of ps.substitutes) {
      data.substitutes[sub] = {
        credentialPath: entry.credentialPath,
        scopeAttrs: entry.scopeAttrs,
      };
    }

    try {
      const filePath = refsPath(groupScope, providerId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', {
        mode: 0o600,
      });
    } catch (err) {
      logger.warn({ err, groupScope, providerId }, 'Refs persistence failed');
    }
  }

  /** Delete a provider's refs file for a scope. */
  private deleteRefs(groupScope: GroupScope, providerId: string): void {
    try {
      fs.unlinkSync(refsPath(groupScope, providerId));
    } catch {
      /* already gone */
    }
  }

  /**
   * Load persisted refs for a given scope and provider.
   * Supports V2 (legacy role-based) and V3 (credentialPath) formats.
   * Old V1 files are discarded.
   */
  loadPersistedRefs(groupScope: GroupScope, providerId: string): number {
    const raw = readJsonFile<Record<string, unknown>>(
      refsPath(groupScope, providerId),
    );

    if (!raw.substitutes || typeof raw.substitutes !== 'object') {
      // V1 or empty — discard, will be regenerated on next provision
      return 0;
    }

    const isV3 = raw.v === 3;
    const sourceScope = (raw.sourceScope as string | undefined)
      ? asCredentialScope(raw.sourceScope as string)
      : undefined;

    const subs = raw.substitutes as Record<string, Record<string, unknown>>;
    const entries = Object.entries(subs);
    if (entries.length === 0) return 0;

    let needsRepersist = false;
    for (const [substitute, entryRaw] of entries) {
      let credentialPath: string;
      if (isV3) {
        credentialPath = entryRaw.credentialPath as string;
      } else {
        // V2 migration: role → credentialPath, skip standalone refresh refs
        const role = entryRaw.role as string;
        if (role === 'refresh') continue; // drop — refresh is nested now
        credentialPath = LEGACY_ROLE_MAP[role] ?? role;
        needsRepersist = true;
      }

      this.insertSub(
        groupScope,
        providerId,
        substitute,
        {
          credentialPath,
          scopeAttrs: (entryRaw.scopeAttrs as Record<string, string>) ?? {},
        },
        sourceScope,
      );
    }

    // Re-persist as V3 if we migrated from V2
    if (needsRepersist) {
      this.persistRefs(groupScope, providerId);
    }

    const loadedCount = this.scopes.get(groupScope)?.get(providerId)?.substitutes.size ?? 0;
    logger.debug(
      { groupScope, providerId, count: loadedCount, sourceScope },
      'Loaded persisted substitute refs',
    );
    return loadedCount;
  }

  /**
   * Scan all scope directories for refs files and load them.
   * Called once at startup after the credential store is initialized.
   */
  loadAllPersistedRefs(): number {
    let total = 0;
    try {
      if (!fs.existsSync(CREDENTIALS_DIR)) return 0;
      const scopeDirs = fs.readdirSync(CREDENTIALS_DIR, {
        withFileTypes: true,
      });
      for (const dir of scopeDirs) {
        if (!dir.isDirectory()) continue;
        const scopePath = path.join(CREDENTIALS_DIR, dir.name);
        const files = fs.readdirSync(scopePath);
        for (const file of files) {
          const m = /^(.+)\.refs\.json$/.exec(file);
          if (m) {
            total += this.loadPersistedRefs(asGroupScope(dir.name), m[1]);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to scan for persisted refs');
    }
    return total;
  }
}
