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
  CredentialResolver,
  Credential,
  GroupScope,
  CredentialScope,
} from './oauth-types.js';
import {
  MIN_RANDOM_CHARS,
  CRED_OAUTH,
  asGroupScope,
  asCredentialScope,
} from './oauth-types.js';
import { onKeysFileWritten, onKeysFileDeleted } from './manifest.js';

/**
 * Use a group's own folder as a credential scope.
 * Internal to the engine — callers should use resolveCredentialScope() instead.
 */
function toCredentialScope(groupScope: GroupScope): CredentialScope {
  return groupScope as unknown as CredentialScope;
}
import { encrypt, decrypt, CREDENTIALS_DIR } from './store.js';
import { resolveGroupFolderPath } from '../group-folder.js';
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

/**
 * Resolve a credentialPath to a real (decrypted) token value.
 * Resolves the credential from cache, then uses extractToken
 * to get the value (decrypting nested sub-tokens on demand).
 */
function resolveCredentialPathToRealToken(
  resolver: CredentialResolver,
  credentialScope: CredentialScope,
  providerId: string,
  credentialPath: string,
): string | null {
  const { id, nested } = parsePath(credentialPath);
  const cred = resolver.resolve(credentialScope, providerId, id);
  if (!cred) return null;
  return resolver.extractToken(cred, nested);
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
export function updateJsonFile<T extends object>(
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

// Credential and AuthToken are defined in oauth-types.ts
export type { Credential, AuthToken } from './oauth-types.js';

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
  access: CRED_OAUTH,
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
    // Find parent: 'access' (or CRED_OAUTH if already renamed)
    const parentId = keys['access'] ? 'access' : keys[CRED_OAUTH] ? CRED_OAUTH : null;
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

  // Rename 'access' → CRED_OAUTH
  if (keys['access']) {
    keys[CRED_OAUTH] = keys['access'];
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
  onKeysFileWritten(credentialScope, providerId);
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
 * Persistent credential resolver.
 *
 * Hot cache: decrypted Credential objects indexed by (scope, provider, credentialId).
 * Refresh sub-tokens are never cached — always read from disk via resolveCold().
 *
 * Keys file: credentials/{credentialScope}/{providerId}.keys.json
 *   { credentialId: { value: encrypted, updated_ts, expires_ts, refresh?: {...} } }
 */
export class PersistentCredentialResolver implements CredentialResolver {
  /** scope → provider → credentialId → Credential (encrypted values). */
  private cache = new Map<CredentialScope, Map<string, Map<string, Credential>>>();

  private cacheGet(
    scope: CredentialScope, provider: string, id: string,
  ): Credential | undefined {
    return this.cache.get(scope)?.get(provider)?.get(id);
  }

  private cacheSet(
    scope: CredentialScope, provider: string, id: string, cred: Credential,
  ): void {
    let scopeMap = this.cache.get(scope);
    if (!scopeMap) { scopeMap = new Map(); this.cache.set(scope, scopeMap); }
    let provMap = scopeMap.get(provider);
    if (!provMap) { provMap = new Map(); scopeMap.set(provider, provMap); }
    provMap.set(id, cred);
  }

  // ── CredentialResolver interface ────────────────────────────────

  store(
    providerId: string,
    credentialScope: CredentialScope,
    credentialId: string,
    credential: Credential,
  ): void {
    const encrypted = this.persistCredential(credentialScope, providerId, credentialId, credential);
    this.loadCache(credentialScope, providerId, credentialId, encrypted);
  }

  resolve(
    credentialScope: CredentialScope,
    providerId: string,
    credentialId: string,
  ): Credential | null {
    if (!this.cacheGet(credentialScope, providerId, credentialId)) {
      try {
        this.loadCache(credentialScope, providerId, credentialId);
      } catch {
        /* encryption not initialized or file not found */
      }
    }
    const cached = this.cacheGet(credentialScope, providerId, credentialId);
    if (!cached) return null;
    return {
      value: cached.value ? decrypt(cached.value) : '',
      expires_ts: cached.expires_ts,
      updated_ts: cached.updated_ts,
      ...(cached.authFields && { authFields: cached.authFields }),
      ...(cached.refresh && {
        refresh: {
          value: cached.refresh.value ? decrypt(cached.refresh.value) : '',
          expires_ts: cached.refresh.expires_ts,
          updated_ts: cached.refresh.updated_ts,
        },
      }),
    };
  }

  extractToken(credential: Credential, subPath?: string): string | null {
    if (!subPath) return credential.value || null;
    const sub = (credential as unknown as Record<string, unknown>)[subPath];
    if (!sub || typeof sub !== 'object' || !('value' in sub)) return null;
    const { value } = sub as { value: string };
    return value || null;
  }

  delete(credentialScope: CredentialScope, providerId?: string): void {
    if (providerId) {
      this.cache.get(credentialScope)?.delete(providerId);
      try {
        fs.unlinkSync(keysPath(credentialScope, providerId));
      } catch { /* already gone */ }
    } else {
      this.cache.delete(credentialScope);
      const scopeDir = path.join(CREDENTIALS_DIR, credentialScope);
      try {
        fs.rmSync(scopeDir, { recursive: true });
      } catch { /* already gone */ }
    }
    onKeysFileDeleted(credentialScope, providerId);
  }

  // ── Test-only methods (not on CredentialResolver interface) ─────

  /** Number of cached credentials across all scopes. */
  get size(): number {
    let n = 0;
    for (const scopeMap of this.cache.values())
      for (const provMap of scopeMap.values())
        n += provMap.size;
    return n;
  }

  /**
   * Load a credential into the hot cache.
   * If credential is provided, uses it directly (values must be encrypted).
   * Otherwise reads from disk (already encrypted).
   * Cache always stores encrypted; resolve() decrypts on the way out.
   */
  loadCache(
    credentialScope: CredentialScope,
    providerId: string,
    credentialId: string,
    credential?: Credential,
  ): void {
    if (credential) {
      this.cacheSet(credentialScope, providerId, credentialId, credential);
      return;
    }
    const keys = readKeysFile(credentialScope, providerId);
    const entry = keys[credentialId];
    if (!entry) return;
    this.cacheSet(credentialScope, providerId, credentialId, {
      value: entry.value || '',
      expires_ts: entry.expires_ts,
      updated_ts: entry.updated_ts,
      ...(entry.authFields && { authFields: entry.authFields }),
      ...(entry.refresh && { refresh: entry.refresh }),
    });
  }

  /** Drop from cache without touching disk. */
  unloadCache(credentialScope: CredentialScope, providerId?: string): void {
    if (providerId) {
      this.cache.get(credentialScope)?.delete(providerId);
    } else {
      this.cache.delete(credentialScope);
    }
  }

  // ── Disk persistence ───────────────────────────────────────────

  /**
   * Write a credential to the keys file. Encrypts plaintext values and
   * preserves existing nested sub-tokens not present in the new credential.
   * Returns the encrypted Credential for direct cache storage.
   */
  private persistCredential(
    credentialScope: CredentialScope,
    providerId: string,
    credentialId: string,
    credential: Credential,
  ): Credential {
    let encrypted: Credential = {
      value: encrypt(credential.value),
      updated_ts: credential.updated_ts,
      expires_ts: credential.expires_ts,
      ...(credential.authFields && { authFields: credential.authFields }),
      ...(credential.refresh && {
        refresh: {
          value: encrypt(credential.refresh.value),
          expires_ts: credential.refresh.expires_ts,
          updated_ts: credential.refresh.updated_ts,
        },
      }),
    };
    try {
      updateJsonFile<KeysFile>(
        keysPath(credentialScope, providerId),
        (keys) => {
          const existing = keys[credentialId];
          // Merge refresh: new credential's refresh wins, else preserve existing
          if (!encrypted.refresh && existing?.refresh) {
            encrypted = { ...encrypted, refresh: existing.refresh };
          }
          keys[credentialId] = encrypted;
          keys.v = KEYS_FILE_VERSION;
        },
      );
      onKeysFileWritten(credentialScope, providerId);
    } catch (err) {
      logger.warn(
        { err, credentialScope, providerId, credentialId },
        'Credential persistence failed',
      );
    }
    return encrypted;
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

  constructor(private resolver: CredentialResolver) {}

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

  /**
   * Store a credential directly by credentialScope. No group logic —
   * used by importEnv to bootstrap .env credentials into default scope.
   */
  storeCredential(
    providerId: string,
    credentialScope: CredentialScope,
    credentialId: string,
    credential: Credential,
  ): void {
    this.resolver.store(providerId, credentialScope, credentialId, credential);
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
  ): { scope: CredentialScope; writable: boolean } {
    const ownScope = toCredentialScope(groupScope);
    const group = this.groupResolver?.(groupScope);
    if (!group) return { scope: ownScope, writable: true };
    // Check own scope first
    if (this.hasKeysInScope(ownScope, providerId))
      return { scope: ownScope, writable: true };
    // Fall back to credentialSource if configured
    const sourceName = group.containerConfig?.credentialSource;
    if (sourceName) {
      const sourceScope = asCredentialScope(sourceName);
      if (this.hasKeysInScope(sourceScope, providerId))
        return { scope: sourceScope, writable: false };
    }
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
    credentialPath: string = CRED_OAUTH,
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
    credentialPath: string = CRED_OAUTH,
  ): string | null {
    const existing = this.getSubstitute(providerId, groupScope, credentialPath);
    if (existing) return existing;

    // Resolve which scope holds the real credentials
    const credScope = this.resolveCredentialScope(groupScope, providerId);
    const ownCredScope = toCredentialScope(groupScope);
    const sourceScope = credScope !== ownCredScope ? credScope : undefined;

    const realToken = resolveCredentialPathToRealToken(
      this.resolver, credScope, providerId, credentialPath,
    );
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
    credentialPath: string = CRED_OAUTH,
    sourceScope?: CredentialScope,
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
    const realToken = resolveCredentialPathToRealToken(
      this.resolver,
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
    return resolveCredentialPathToRealToken(
      this.resolver, effCredScope, providerId, credentialPath,
    );
  }

  /**
   * Resolve a cached Credential by (group, provider, credentialId).
   * Handles source-scope indirection internally. Top-level only.
   */
  resolveCredential(
    groupScope: GroupScope,
    providerId: string,
    credentialId: string,
  ): Credential | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const effCredScope = ps
      ? this.effectiveScope(groupScope, ps)
      : toCredentialScope(groupScope);
    return this.resolver.resolve(effCredScope, providerId, credentialId);
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

    let targetScope: CredentialScope;
    if (!ps) {
      targetScope = ownScope;
    } else if (ps.sourceScope) {
      if (this.accessCheck && !this.accessCheck(groupScope, ps.sourceScope)) {
        targetScope = ownScope;
        ps.sourceScope = undefined;
        this.persistRefs(groupScope, providerId);
        logger.info(
          { groupScope, providerId },
          'Credential promoted to own scope (access revoked on refresh)',
        );
      } else {
        targetScope = ps.sourceScope;
      }
    } else {
      targetScope = ownScope;
    }

    this.storeByPath(targetScope, providerId, credentialPath, newToken, expiresTs, authFields);
  }

  /**
   * Store a token by credentialPath. For top-level paths, stores a new
   * Credential. For nested paths (e.g. 'oauth/refresh'), reads the
   * existing credential and updates the nested sub-token.
   */
  private storeByPath(
    credentialScope: CredentialScope,
    providerId: string,
    credentialPath: string,
    token: string,
    expiresTs: number,
    authFields?: Record<string, string>,
  ): void {
    const { id, nested } = parsePath(credentialPath);
    if (!nested) {
      this.resolver.store(providerId, credentialScope, id, {
        value: token,
        expires_ts: expiresTs,
        updated_ts: Date.now(),
        ...(authFields && { authFields }),
      });
      return;
    }
    // Nested: read existing credential, update sub-token, store back
    const existing = this.resolver.resolve(credentialScope, providerId, id);
    if (!existing) {
      logger.warn(
        { credentialScope, providerId, credentialPath },
        'Cannot store nested credential without existing parent',
      );
      return;
    }
    const cred: Credential = { ...existing };
    (cred as unknown as Record<string, unknown>)[nested] = {
      value: token,
      expires_ts: expiresTs,
      updated_ts: Date.now(),
    };
    this.resolver.store(providerId, credentialScope, id, cred);
  }

  /**
   * Store a newly obtained credential for a group.
   * Always writes to the group's own scope. If the provider currently
   * has borrowed substitutes, they are revoked first (ownership takeover).
   */
  storeGroupCredential(
    groupScope: GroupScope,
    providerId: string,
    credentialId: string,
    credential: Credential,
  ): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (ps?.sourceScope) {
      this.revokeProvider(groupScope, providerId);
    }
    this.resolver.store(
      providerId,
      toCredentialScope(groupScope),
      credentialId,
      credential,
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
      this.resolver.delete(toCredentialScope(groupScope), providerId);
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
        this.resolver.delete(credScope, providerId);
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
        this.resolver.delete(credScope, pid);
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
    this.resolver.delete(effCredScope, providerId);
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
      const realToken = resolveCredentialPathToRealToken(
        this.resolver, effCredScope, providerId, entry.credentialPath,
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

    this.persistCredentialInfo(groupScope, providerId);
  }

  /** Delete a provider's refs file for a scope. */
  private deleteRefs(groupScope: GroupScope, providerId: string): void {
    try {
      fs.unlinkSync(refsPath(groupScope, providerId));
    } catch {
      /* already gone */
    }
    this.deleteCredentialInfo(groupScope, providerId);
  }

  // ── Credential info files (group folder) ────────────────────────────

  /**
   * Write a per-provider JSONL file into the group's credentials subfolder.
   * One line per top-level credential (nested paths like oauth/refresh excluded).
   * Each line: {"provider":"github","name":"oauth","token":"ghp_..."}
   * Includes the substitute token (safe — format-preserving fake, not real).
   */
  private persistCredentialInfo(groupScope: GroupScope, providerId: string): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(groupScope as string);
    } catch {
      return;
    }

    const ps = this.scopes.get(groupScope)?.get(providerId);
    const filePath = path.join(groupDir, 'credentials', 'tokens', `${providerId}.jsonl`);

    if (!ps || ps.substitutes.size === 0) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      return;
    }

    const borrowed = !!ps.sourceScope;
    const byCredential = new Map<string, string[]>();
    for (const [sub, entry] of ps.substitutes) {
      const topLevel = entry.credentialPath.split('/')[0];
      if (!byCredential.has(topLevel)) byCredential.set(topLevel, []);
      byCredential.get(topLevel)!.push(sub);
    }

    const lines: string[] = [];
    for (const [name, subs] of byCredential) {
      subs.sort();
      const obj: Record<string, unknown> = { provider: providerId, name, token: subs[0] };
      if (borrowed) obj.borrowed = true;
      lines.push(JSON.stringify(obj));
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, lines.join('\n') + '\n');
    } catch (err) {
      logger.warn({ err, groupScope, providerId }, 'Credential info write failed');
    }
  }

  /** Remove a provider's credential info file from the group folder. */
  private deleteCredentialInfo(groupScope: GroupScope, providerId: string): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(groupScope as string);
    } catch {
      return;
    }
    try {
      fs.unlinkSync(path.join(groupDir, 'credentials', 'tokens', `${providerId}.jsonl`));
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

  /**
   * Regenerate credential info files for all loaded group scopes.
   * Call after loadAllPersistedRefs() to ensure the JSONL files exist
   * even when no new substitutes are generated.
   */
  regenerateAllCredentialInfo(): void {
    for (const [groupScope, pmap] of this.scopes) {
      // Remove stale files from previous runs
      try {
        const dir = path.join(
          resolveGroupFolderPath(groupScope as string),
          'credentials', 'tokens',
        );
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      } catch { /* best effort */ }

      for (const providerId of pmap.keys()) {
        this.persistCredentialInfo(groupScope, providerId);
      }
    }
  }
}
