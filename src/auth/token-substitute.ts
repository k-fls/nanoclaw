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
  asGroupScope,
  asCredentialScope,
  toCredentialScope,
} from './oauth-types.js';
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

/** Token role — used as part of the credential store service key. */
export type TokenRole = 'access' | 'refresh' | 'api_key';

/** Cache key for in-memory hot tokens. */
function cacheKey(
  credentialScope: CredentialScope,
  providerId: string,
  role: string,
): string {
  return `${credentialScope}\0${providerId}\0${role}`;
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

export interface KeyEntry extends AuthToken {
  updated_ts: number; // epoch ms — per role
}

export type KeysFile = Record<string, KeyEntry>;

export function keysPath(
  credentialScope: CredentialScope,
  providerId: string,
): string {
  return path.join(CREDENTIALS_DIR, credentialScope, `${providerId}.keys.json`);
}

export function readKeysFile(
  credentialScope: CredentialScope,
  providerId: string,
): KeysFile {
  return readJsonFile<KeysFile>(keysPath(credentialScope, providerId));
}

export function writeKeysFile(
  credentialScope: CredentialScope,
  providerId: string,
  keys: KeysFile,
): void {
  const p = keysPath(credentialScope, providerId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Refs file: credentials/{groupScope}/{providerId}.refs.json
// Per-provider substitute mappings with optional sourceScope. No secrets.
// ---------------------------------------------------------------------------

/** V2 refs file format. */
interface RefsFileV2 {
  sourceScope?: string;
  substitutes: Record<
    string,
    { role: TokenRole; scopeAttrs: Record<string, string> }
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
 * - Access tokens / API keys: cached in memory (hot path, every request)
 *   AND persisted to keys file.
 * - Refresh tokens: persisted only, read from disk on demand (cold path,
 *   only used during token refresh).
 *
 * Keys file: credentials/{credentialScope}/{providerId}.keys.json
 *   { role: { value: encrypted, updated_ts, expires_ts } }
 */
export class PersistentTokenResolver implements TokenResolver {
  /** Hot cache: cacheKey → real token. Refresh tokens are NOT cached. */
  private hotCache = new Map<string, string>();
  /** Auth fields cache: cacheKey → authFields. Mirrors hot cache lifetime. */
  private authFieldsCache = new Map<string, Record<string, string>>();

  store(
    realToken: string,
    providerId: string,
    credentialScope: CredentialScope,
    role: TokenRole = 'access',
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): void {
    const persisted = this.persistToKeys(
      credentialScope,
      providerId,
      role,
      realToken,
      expiresTs,
      authFields,
    );
    // Refresh tokens are cold (disk-only) when persistence works.
    // Fall back to in-memory cache if persistence is unavailable.
    const ck = cacheKey(credentialScope, providerId, role);
    if (role !== 'refresh' || !persisted) {
      this.hotCache.set(ck, realToken);
    }
    if (authFields) {
      this.authFieldsCache.set(ck, authFields);
    }
  }

  resolve(
    credentialScope: CredentialScope,
    providerId: string,
    role: string,
  ): string | null {
    // Hot path: cached access/api_key tokens
    const cached = this.hotCache.get(
      cacheKey(credentialScope, providerId, role),
    );
    if (cached !== undefined) return cached;
    // Cold path: read from disk (refresh tokens, or after restart)
    return this.loadFromKeys(credentialScope, providerId, role as TokenRole);
  }

  /** Update a real token in place (e.g. after refresh). */
  update(
    credentialScope: CredentialScope,
    providerId: string,
    role: TokenRole,
    newRealToken: string,
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): void {
    this.persistToKeys(
      credentialScope,
      providerId,
      role,
      newRealToken,
      expiresTs,
      authFields,
    );
    const ck = cacheKey(credentialScope, providerId, role);
    if (role !== 'refresh') {
      this.hotCache.set(ck, newRealToken);
    }
    if (authFields) {
      this.authFieldsCache.set(ck, authFields);
    }
  }

  revoke(credentialScope: CredentialScope, providerId?: string): void {
    const prefix = credentialScope + '\0' + (providerId ?? '');
    for (const key of this.hotCache.keys()) {
      if (key.startsWith(prefix)) {
        this.hotCache.delete(key);
        this.authFieldsCache.delete(key);
      }
    }
  }

  /** Delete the on-disk keys file for a (scope, provider). */
  deleteKeys(credentialScope: CredentialScope, providerId: string): void {
    try {
      fs.unlinkSync(keysPath(credentialScope, providerId));
    } catch {
      /* already gone */
    }
  }

  /** Number of hot-cached tokens (for testing). */
  get size(): number {
    return this.hotCache.size;
  }

  /** Read the full KeyEntry for a role (includes authFields). Checks disk first, falls back to memory. */
  resolveKeyEntry(
    credentialScope: CredentialScope,
    providerId: string,
    role: TokenRole,
  ): KeyEntry | null {
    const keys = readJsonFile<KeysFile>(keysPath(credentialScope, providerId));
    if (keys[role]) return keys[role];
    // Fall back to in-memory authFields (e.g. when credential store isn't initialized)
    const ck = cacheKey(credentialScope, providerId, role);
    const cached = this.authFieldsCache.get(ck);
    if (cached)
      return { value: '', updated_ts: 0, expires_ts: 0, authFields: cached };
    return null;
  }

  /** Locked read-merge-write one role into the provider's keys file. */
  private persistToKeys(
    credentialScope: CredentialScope,
    providerId: string,
    role: TokenRole,
    realToken: string,
    expiresTs = 0,
    authFields?: Record<string, string>,
  ): boolean {
    try {
      updateJsonFile<KeysFile>(
        keysPath(credentialScope, providerId),
        (keys) => {
          keys[role] = {
            value: encrypt(realToken),
            updated_ts: Date.now(),
            expires_ts: expiresTs,
            ...(authFields && { authFields }),
          };
        },
      );
      return true;
    } catch (err) {
      logger.warn(
        { err, credentialScope, providerId, role },
        'Token persistence failed',
      );
      return false;
    }
  }

  /** Read one role from the provider's keys file. */
  private loadFromKeys(
    credentialScope: CredentialScope,
    providerId: string,
    role: TokenRole,
  ): string | null {
    const keys = readJsonFile<KeysFile>(keysPath(credentialScope, providerId));
    const entry = keys[role];
    if (!entry) return null;
    return decrypt(entry.value);
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
   * Resolve credential source scope for a (group, provider) pair.
   * Uses group flags (useDefaultCredentials, isMain) and keys file checks.
   * Returns groupScope (as CredentialScope) if resolution is impossible.
   */
  private resolveCredentialScope(
    groupScope: GroupScope,
    providerId: string,
  ): CredentialScope {
    const group = this.groupResolver?.(groupScope);
    if (!group) return toCredentialScope(groupScope);
    const useDefault =
      group.containerConfig?.useDefaultCredentials ?? group.isMain === true;
    // Main + default: main manages default directly
    if (group.isMain && useDefault) return asCredentialScope('default');
    // Check own scope first
    if (this.hasKeysInScope(toCredentialScope(groupScope), providerId))
      return toCredentialScope(groupScope);
    // Fall back to default if allowed
    if (
      useDefault &&
      this.hasKeysInScope(asCredentialScope('default'), providerId)
    )
      return asCredentialScope('default');
    return toCredentialScope(groupScope);
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
   * Get existing substitute for (providerId, groupScope, role).
   * Returns null if none exists. When multiple exist (from token refreshes),
   * returns the first when sorted — stable and deterministic.
   */
  getSubstitute(
    providerId: string,
    groupScope: GroupScope,
    role: TokenRole = 'access',
  ): string | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return null;
    const matches: string[] = [];
    for (const [sub, entry] of ps.substitutes) {
      if (entry.role === role) matches.push(sub);
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
    role: TokenRole = 'access',
  ): string | null {
    const existing = this.getSubstitute(providerId, groupScope, role);
    if (existing) return existing;

    // Resolve which scope holds the real credentials
    const credScope = this.resolveCredentialScope(groupScope, providerId);
    const ownCredScope = toCredentialScope(groupScope);
    const sourceScope = credScope !== ownCredScope ? credScope : undefined;

    const realToken = this.resolver.resolve(credScope, providerId, role);
    if (!realToken) return null;

    return this.generateSubstitute(
      realToken,
      providerId,
      scopeAttrs,
      groupScope,
      config,
      role,
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
    role: TokenRole = 'access',
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
        role,
        0,
        authFields,
      );

      // Store in the engine
      const entry: SubstituteEntry = { role, scopeAttrs };
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
      entry.role,
    );
    if (!realToken) return null;

    return {
      realToken,
      mapping: {
        providerId: ref.providerId,
        role: entry.role,
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
   * Resolve a real token for a (group, provider, role) without going
   * through a substitute. Used by refresh flows that need the real
   * refresh token to call a token endpoint.
   *
   * Handles sourceScope indirection internally.
   */
  resolveRealToken(
    groupScope: GroupScope,
    providerId: string,
    role: TokenRole,
  ): string | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    return this.resolver.resolve(effCredScope, providerId, role);
  }

  /** Get the full KeyEntry for a role, resolving source scope. */
  getKeyEntry(
    groupScope: GroupScope,
    providerId: string,
    role: TokenRole,
  ): KeyEntry | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    return (this.resolver as PersistentTokenResolver).resolveKeyEntry(
      effCredScope,
      providerId,
      role,
    );
  }

  /**
   * Get the expiry timestamp for a credential role, resolving source scope.
   * Returns 0 if not found or no expiry set.
   */
  getKeyExpiry(
    groupScope: GroupScope,
    providerId: string,
    role: TokenRole,
  ): number {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    const keys = readKeysFile(effCredScope, providerId);
    return keys[role]?.expires_ts ?? 0;
  }

  /**
   * Refresh a credential. Writes to the source scope if borrowed and
   * access is still allowed. If access is denied, promotes to own scope.
   */
  refreshCredential(
    groupScope: GroupScope,
    providerId: string,
    role: TokenRole,
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
        role,
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
          role,
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
        role,
        newToken,
        expiresTs,
        authFields,
      );
    } else {
      (this.resolver as PersistentTokenResolver).update(
        ownScope,
        providerId,
        role,
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
    role: TokenRole,
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
      role,
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
      role,
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
   */
  private hasKeysInScope(
    credentialScope: CredentialScope,
    providerId: string,
    nonExpired = false,
  ): boolean {
    const keys = readKeysFile(credentialScope, providerId);
    for (const role of ['access', 'api_key'] as const) {
      const entry = keys[role];
      if (!entry) continue;
      if (nonExpired && entry.expires_ts > 0 && entry.expires_ts < Date.now())
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

  /** Revoke all substitutes for a group scope (and optionally a provider). */
  revokeByScope(groupScope: GroupScope, providerId?: string): number {
    if (providerId) {
      const ps = this.scopes.get(groupScope)?.get(providerId);
      if (!ps) return 0;
      const count = ps.substitutes.size;
      this.revokeProvider(groupScope, providerId);
      // Always revoke from resolver + delete keys file when explicitly requested
      this.resolver.revoke(toCredentialScope(groupScope), providerId);
      (this.resolver as PersistentTokenResolver).deleteKeys(
        toCredentialScope(groupScope),
        providerId,
      );
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
    }
    this.scopes.delete(groupScope);
    this.resolver.revoke(toCredentialScope(groupScope));
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
        entry.role,
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

    const data: RefsFileV2 = {
      substitutes: {},
    };
    if (ps.sourceScope) data.sourceScope = ps.sourceScope;
    for (const [sub, entry] of ps.substitutes) {
      data.substitutes[sub] = {
        role: entry.role as TokenRole,
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
   * Supports only V2 format (has `substitutes` key). Old V1 files are discarded.
   */
  loadPersistedRefs(groupScope: GroupScope, providerId: string): number {
    const raw = readJsonFile<Record<string, unknown>>(
      refsPath(groupScope, providerId),
    );

    // V2 format: has `substitutes` key
    if (!raw.substitutes || typeof raw.substitutes !== 'object') {
      // V1 or empty — discard, will be regenerated on next provision
      return 0;
    }

    const data = raw as unknown as RefsFileV2;
    const entries = Object.entries(data.substitutes);
    if (entries.length === 0) return 0;

    const sourceScope = data.sourceScope
      ? asCredentialScope(data.sourceScope)
      : undefined;

    for (const [substitute, entry] of entries) {
      this.insertSub(
        groupScope,
        providerId,
        substitute,
        {
          role: entry.role,
          scopeAttrs: entry.scopeAttrs,
        },
        sourceScope,
      );
    }

    logger.debug(
      { groupScope, providerId, count: entries.length, sourceScope },
      'Loaded persisted substitute refs',
    );
    return entries.length;
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
