/**
 * Format-preserving token substitute engine.
 *
 * Generates substitute tokens that look like the real ones (same prefix,
 * suffix, delimiter positions, character classes) but with randomized
 * middle sections. Containers never see real tokens — only substitutes.
 *
 * The engine does NOT store credentials. It stores SubstituteMappings
 * (identity info + opaque handle) and delegates real-token storage/retrieval
 * to a pluggable TokenResolver.
 *
 * Scoped by containerScope: each container's substitutes are isolated.
 */
import { randomInt } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { SubstituteConfig, SubstituteMapping, TokenResolver } from './oauth-types.js';
import { MIN_RANDOM_CHARS } from './oauth-types.js';
import { encrypt, decrypt, CREDENTIALS_DIR } from './store.js';
import { logger } from '../logger.js';

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
function cacheKey(containerScope: string, providerId: string, role: string): string {
  return `${containerScope}\0${providerId}\0${role}`;
}

// ---------------------------------------------------------------------------
// Keys file: credentials/{scope}/{providerId}.keys.json
// All roles for one provider in one file. No secrets in plaintext.
// ---------------------------------------------------------------------------

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
function updateJsonFile<T extends object>(filePath: string, update: (data: T) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let fd: number;
  let data = {} as T;

  try {
    fd = fs.openSync(filePath, 'r+');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
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
// Keys file: credentials/{scope}/{providerId}.keys.json
// All roles for one provider in one file. No plaintext secrets.
// ---------------------------------------------------------------------------

export interface KeyEntry {
  value: string;      // encrypted token
  updated_ts: number;  // epoch ms
  expires_ts: number;  // epoch ms, 0 = no expiry
}

export type KeysFile = Record<string, KeyEntry>;

export function keysPath(scope: string, providerId: string): string {
  return path.join(CREDENTIALS_DIR, scope, `${providerId}.keys.json`);
}

export function readKeysFile(scope: string, providerId: string): KeysFile {
  return readJsonFile<KeysFile>(keysPath(scope, providerId));
}

export function writeKeysFile(scope: string, providerId: string, keys: KeysFile): void {
  const p = keysPath(scope, providerId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Refs file: credentials/{scope}/{providerId}.refs.json
// Map of substitute string → { role, scopeAttrs }. No secrets.
// ---------------------------------------------------------------------------

interface RefEntry {
  role: TokenRole;
  scopeAttrs: Record<string, string>;
}

type RefsFile = Record<string, RefEntry>;

function refsPath(scope: string, providerId: string): string {
  return path.join(CREDENTIALS_DIR, scope, `${providerId}.refs.json`);
}

/**
 * Persistent token resolver — keyed by (containerScope, providerId, role).
 *
 * - Access tokens / API keys: cached in memory (hot path, every request)
 *   AND persisted to keys file.
 * - Refresh tokens: persisted only, read from disk on demand (cold path,
 *   only used during token refresh).
 *
 * Keys file: credentials/{scope}/{providerId}.keys.json
 *   { role: { value: encrypted, updated_ts, expires_ts } }
 */
export class PersistentTokenResolver implements TokenResolver {
  /** Hot cache: cacheKey → real token. Refresh tokens are NOT cached. */
  private hotCache = new Map<string, string>();

  store(realToken: string, providerId: string, containerScope: string, role: TokenRole = 'access'): void {
    const persisted = this.persistToKeys(containerScope, providerId, role, realToken);
    // Refresh tokens are cold (disk-only) when persistence works.
    // Fall back to in-memory cache if persistence is unavailable.
    if (role !== 'refresh' || !persisted) {
      this.hotCache.set(cacheKey(containerScope, providerId, role), realToken);
    }
  }

  resolve(containerScope: string, providerId: string, role: string): string | null {
    // Hot path: cached access/api_key tokens
    const cached = this.hotCache.get(cacheKey(containerScope, providerId, role));
    if (cached !== undefined) return cached;
    // Cold path: read from disk (refresh tokens, or after restart)
    return this.loadFromKeys(containerScope, providerId, role as TokenRole);
  }

  /** Update a real token in place (e.g. after refresh). */
  update(containerScope: string, providerId: string, role: TokenRole, newRealToken: string, expiresTs = 0): void {
    this.persistToKeys(containerScope, providerId, role, newRealToken, expiresTs);
    if (role !== 'refresh') {
      this.hotCache.set(cacheKey(containerScope, providerId, role), newRealToken);
    }
  }

  revoke(containerScope: string, providerId?: string): void {
    const prefix = containerScope + '\0' + (providerId ?? '');
    for (const key of this.hotCache.keys()) {
      if (key.startsWith(prefix)) {
        this.hotCache.delete(key);
      }
    }
  }

  /** Number of hot-cached tokens (for testing). */
  get size(): number {
    return this.hotCache.size;
  }

  /** Locked read-merge-write one role into the provider's keys file. */
  private persistToKeys(scope: string, providerId: string, role: TokenRole, realToken: string, expiresTs = 0): boolean {
    try {
      updateJsonFile<KeysFile>(keysPath(scope, providerId), (keys) => {
        keys[role] = {
          value: encrypt(realToken),
          updated_ts: Date.now(),
          expires_ts: expiresTs,
        };
      });
      return true;
    } catch (err) {
      logger.warn({ err, scope, providerId, role }, 'Token persistence failed');
      return false;
    }
  }

  /** Read one role from the provider's keys file. */
  private loadFromKeys(scope: string, providerId: string, role: TokenRole): string | null {
    const keys = readJsonFile<KeysFile>(keysPath(scope, providerId));
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

export class TokenSubstituteEngine {
  /**
   * Two-level lookup: containerScope → substitute → SubstituteMapping.
   * Each container's substitutes are fully isolated.
   * No credentials stored here — only identity + handle.
   */
  private scopes = new Map<string, Map<string, SubstituteMapping>>();

  constructor(private resolver: TokenResolver) {}

  /** Access the underlying token resolver (e.g. for refresh operations). */
  getResolver(): TokenResolver {
    return this.resolver;
  }

  private scopeMap(containerScope: string): Map<string, SubstituteMapping> {
    let map = this.scopes.get(containerScope);
    if (!map) {
      map = new Map();
      this.scopes.set(containerScope, map);
    }
    return map;
  }

  /**
   * Get existing substitute for (scope, providerId, role).
   * Returns null if none exists. When multiple exist (from token refreshes),
   * returns the first when sorted — stable and deterministic.
   */
  getSubstitute(
    providerId: string,
    containerScope: string,
    role: TokenRole = 'access',
  ): string | null {
    const map = this.scopes.get(containerScope);
    if (!map) return null;
    const matches: string[] = [];
    for (const [sub, m] of map) {
      if (m.providerId === providerId && m.role === role) {
        matches.push(sub);
      }
    }
    if (matches.length === 0) return null;
    return matches.sort()[0];
  }

  /**
   * Get existing substitute, or generate one from the resolver's keys file.
   * Used by providers at container startup — never needs a real token arg.
   * Returns null if no real token in the resolver and no existing substitute.
   */
  getOrCreateSubstitute(
    providerId: string,
    scopeAttrs: Record<string, string>,
    containerScope: string,
    config: SubstituteConfig,
    role: TokenRole = 'access',
  ): string | null {
    const existing = this.getSubstitute(providerId, containerScope, role);
    if (existing) return existing;

    const realToken = this.resolver.resolve(containerScope, providerId, role);
    if (!realToken) return null;

    return this.generateSubstitute(realToken, providerId, scopeAttrs, containerScope, config, role);
  }

  /**
   * Generate a format-preserving substitute for a real token.
   *
   * Stores the real token via the TokenResolver and records the mapping.
   * Returns null if the token is too short to safely randomize.
   */
  generateSubstitute(
    realToken: string,
    providerId: string,
    scopeAttrs: Record<string, string>,
    containerScope: string,
    config: SubstituteConfig,
    role: TokenRole = 'access',
  ): string | null {
    const { prefixLen, suffixLen, delimiters } = config;

    if (realToken.length <= prefixLen + suffixLen) {
      return null;
    }

    const prefix = realToken.slice(0, prefixLen);
    const suffix = suffixLen > 0 ? realToken.slice(-suffixLen) : '';
    const middle = suffixLen > 0
      ? realToken.slice(prefixLen, -suffixLen)
      : realToken.slice(prefixLen);

    let randomizable = 0;
    for (const ch of middle) {
      if (!delimiters.includes(ch)) randomizable++;
    }

    if (randomizable < MIN_RANDOM_CHARS) {
      return null;
    }

    const map = this.scopeMap(containerScope);

    for (let attempt = 0; attempt < 3; attempt++) {
      const randomizedMiddle = Array.from(middle)
        .map((ch) => randomCharSameClass(ch, delimiters))
        .join('');

      const substitute = prefix + randomizedMiddle + suffix;

      if (substitute === realToken) continue;
      if (map.has(substitute)) continue;

      // Persist real token via resolver
      this.resolver.store(realToken, providerId, containerScope, role);

      const mapping: SubstituteMapping = {
        providerId,
        role,
        scopeAttrs,
        containerScope,
      };
      map.set(substitute, mapping);

      // Persist substitute → role mapping (no secrets)
      this.persistRef(containerScope, providerId, substitute, role, scopeAttrs);

      return substitute;
    }

    return null;
  }

  /**
   * Resolve a substitute to the real token + metadata.
   * Returns null if unknown substitute, wrong scope, or resolver can't find the token.
   */
  resolveSubstitute(substitute: string, containerScope: string): ResolvedToken | null {
    const map = this.scopes.get(containerScope);
    if (!map) return null;
    const mapping = map.get(substitute);
    if (!mapping) return null;
    const realToken = this.resolver.resolve(mapping.containerScope, mapping.providerId, mapping.role);
    if (!realToken) return null;
    return { realToken, mapping };
  }

  /**
   * Resolve with scope attribute restriction.
   * See resolveWithRestriction in the previous version for semantics.
   */
  resolveWithRestriction(
    substitute: string,
    containerScope: string,
    requiredAttrs: Record<string, string>,
  ): ResolvedToken | null {
    const resolved = this.resolveSubstitute(substitute, containerScope);
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

  /** Revoke all substitutes for a container scope (and optionally a provider). */
  revokeByScope(containerScope: string, providerId?: string): number {
    // Also revoke from the resolver
    this.resolver.revoke(containerScope, providerId);

    if (!providerId) {
      const map = this.scopes.get(containerScope);
      if (!map) return 0;
      // Collect provider IDs for refs cleanup
      const providerIds = new Set<string>();
      for (const mapping of map.values()) providerIds.add(mapping.providerId);
      for (const pid of providerIds) this.deleteRefs(containerScope, pid);
      const count = map.size;
      this.scopes.delete(containerScope);
      return count;
    }

    this.deleteRefs(containerScope, providerId);

    const map = this.scopes.get(containerScope);
    if (!map) return 0;
    let revoked = 0;
    for (const [sub, mapping] of map) {
      if (mapping.providerId === providerId) {
        map.delete(sub);
        revoked++;
      }
    }
    if (map.size === 0) this.scopes.delete(containerScope);
    return revoked;
  }

  /** Number of active substitutes across all scopes. */
  get size(): number {
    let total = 0;
    for (const map of this.scopes.values()) {
      total += map.size;
    }
    return total;
  }

  /** Number of active scopes. */
  get scopeCount(): number {
    return this.scopes.size;
  }

  // ── Refs persistence ──────────────────────────────────────────────

  /**
   * Persist a substitute → role mapping to the provider's refs file.
   */
  private persistRef(
    containerScope: string,
    providerId: string,
    substitute: string,
    role: TokenRole,
    scopeAttrs: Record<string, string>,
  ): void {
    try {
      updateJsonFile<RefsFile>(refsPath(containerScope, providerId), (refs) => {
        // Keep old substitutes — containers may still hold them after restart.
        // Cleanup happens via revokeByScope / deleteRefs.
        refs[substitute] = { role, scopeAttrs };
      });
    } catch (err) {
      logger.warn({ err, containerScope, providerId }, 'Refs persistence failed');
    }
  }

  /**
   * Delete a provider's refs file for a scope.
   */
  private deleteRefs(containerScope: string, providerId: string): void {
    try {
      fs.unlinkSync(refsPath(containerScope, providerId));
    } catch { /* already gone */ }
  }

  /**
   * Load persisted refs for a given scope and provider, rebuilding the
   * engine's scopes map. Called on startup for each scope/provider that
   * has a .refs.json file.
   */
  loadPersistedRefs(containerScope: string, providerId: string): number {
    const refs = readJsonFile<RefsFile>(refsPath(containerScope, providerId));
    const entries = Object.entries(refs);
    if (entries.length === 0) return 0;

    const map = this.scopeMap(containerScope);
    for (const [substitute, entry] of entries) {
      map.set(substitute, {
        providerId,
        role: entry.role,
        scopeAttrs: entry.scopeAttrs,
        containerScope,
      });
    }
    logger.debug(
      { containerScope, providerId, count: entries.length },
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
      const scopeDirs = fs.readdirSync(CREDENTIALS_DIR, { withFileTypes: true });
      for (const dir of scopeDirs) {
        if (!dir.isDirectory()) continue;
        const scopePath = path.join(CREDENTIALS_DIR, dir.name);
        const files = fs.readdirSync(scopePath);
        for (const file of files) {
          const m = /^(.+)\.refs\.json$/.exec(file);
          if (m) {
            total += this.loadPersistedRefs(dir.name, m[1]);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to scan for persisted refs');
    }
    return total;
  }
}
