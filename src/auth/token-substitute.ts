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

import type { SubstituteConfig, SubstituteMapping, TokenResolver } from './oauth-types.js';
import { MIN_RANDOM_CHARS } from './oauth-types.js';

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
 * Simple in-memory TokenResolver. Stores real tokens in a Map keyed by handle.
 * Suitable for ephemeral token storage (substitutes regenerated each session).
 */
export class InMemoryTokenResolver implements TokenResolver {
  private tokens = new Map<string, { realToken: string; providerId: string; containerScope: string }>();
  private nextId = 0;

  store(realToken: string, providerId: string, containerScope: string): string {
    const handle = `tok_${this.nextId++}`;
    this.tokens.set(handle, { realToken, providerId, containerScope });
    return handle;
  }

  resolve(handle: string): string | null {
    return this.tokens.get(handle)?.realToken ?? null;
  }

  /** Update the real token behind a handle (e.g. after refresh). */
  update(handle: string, newRealToken: string): boolean {
    const entry = this.tokens.get(handle);
    if (!entry) return false;
    entry.realToken = newRealToken;
    return true;
  }

  revoke(containerScope: string, providerId?: string): void {
    for (const [handle, entry] of this.tokens) {
      if (entry.containerScope === containerScope) {
        if (!providerId || entry.providerId === providerId) {
          this.tokens.delete(handle);
        }
      }
    }
  }

  /** Number of stored tokens (for testing). */
  get size(): number {
    return this.tokens.size;
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

  private scopeMap(containerScope: string): Map<string, SubstituteMapping> {
    let map = this.scopes.get(containerScope);
    if (!map) {
      map = new Map();
      this.scopes.set(containerScope, map);
    }
    return map;
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

      // Store real token via resolver, get opaque handle
      const handle = this.resolver.store(realToken, providerId, containerScope);

      map.set(substitute, {
        handle,
        providerId,
        scopeAttrs,
        containerScope,
      });

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
    const realToken = this.resolver.resolve(mapping.handle);
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
      const count = map.size;
      this.scopes.delete(containerScope);
      return count;
    }

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
}
