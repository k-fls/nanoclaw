/**
 * Types for the universal OAuth provider system.
 *
 * Discovery-file-driven proxy rules: adding a provider = dropping a JSON file
 * in docs/oauth-discovery/. These types describe the parsed result.
 */

// ---------------------------------------------------------------------------
// Intercept rules (3-level matching: anchor → host regex → path regex)
// ---------------------------------------------------------------------------

export interface InterceptRule {
  /** Level 1: one domain suffix or exact host for fast O(1) rejection. */
  anchor: string;
  /** Level 2: named groups = scope attrs. Absent = always proceed. */
  hostPattern?: RegExp;
  /** Level 3: per-request path match. */
  pathPattern: RegExp;
  mode: 'token-exchange' | 'authorize-stub' | 'bearer-swap';
}

// ---------------------------------------------------------------------------
// Provider (one per discovery JSON file)
// ---------------------------------------------------------------------------

export interface OAuthProvider {
  /** Filename sans .json. */
  id: string;
  rules: InterceptRule[];
  /** Which named groups from hostPattern regexes scope credentials. */
  scopeKeys: string[];
  substituteConfig: SubstituteConfig;
}

// ---------------------------------------------------------------------------
// Token substitute configuration
// ---------------------------------------------------------------------------

export interface SubstituteConfig {
  /** Characters to preserve from the start of the real token. */
  prefixLen: number;
  /** Characters to preserve from the end of the real token. */
  suffixLen: number;
  /** Delimiter chars to preserve in-place (e.g. "-._"). */
  delimiters: string;
}

export const DEFAULT_SUBSTITUTE_CONFIG: SubstituteConfig = {
  prefixLen: 10,
  suffixLen: 4,
  delimiters: '-._~',
};

/** Minimum randomized characters in the middle section (safety floor). */
export const MIN_RANDOM_CHARS = 16;

// ---------------------------------------------------------------------------
// Token substitute mapping (stored by the engine — no credentials)
// ---------------------------------------------------------------------------

/**
 * Identity of a substitute token. The engine stores this, not the real token.
 * The real token is resolved at request time via TokenResolver using
 * the natural key (containerScope, providerId, role).
 */
export interface SubstituteMapping {
  providerId: string;
  role: string;
  scopeAttrs: Record<string, string>;
  containerScope: string;
}

/**
 * Pluggable credential store interface. The engine delegates real-token
 * storage and retrieval to this — it never holds credentials itself.
 * Credentials are keyed by (containerScope, providerId, role) — no handles.
 */
export interface TokenResolver {
  /** Store (or update) a real token. */
  store(realToken: string, providerId: string, containerScope: string, role?: string): void;
  /** Retrieve the current real token. Returns null if not found or revoked. */
  resolve(containerScope: string, providerId: string, role: string): string | null;
  /** Remove all tokens for a scope (and optionally a provider). */
  revoke(containerScope: string, providerId?: string): void;
}

// ---------------------------------------------------------------------------
// Refresh strategy for bearer-swap 401/403 handling
// ---------------------------------------------------------------------------

export type RefreshStrategy = 'redirect' | 'buffer' | 'passthrough';
