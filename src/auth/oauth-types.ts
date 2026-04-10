/**
 * Types for the universal OAuth provider system.
 *
 * Discovery-file-driven proxy rules: adding a provider = dropping a JSON file
 * in src/auth/oauth-discovery/. These types describe the parsed result.
 */

// ---------------------------------------------------------------------------
// Branded scope types — prevent mixing up group folders and credential scopes
// ---------------------------------------------------------------------------

declare const __credentialScope: unique symbol;
declare const __groupScope: unique symbol;

/**
 * Where credentials are stored on disk: a group folder name or 'default'.
 * Used by the resolver, file helpers, and storage layer.
 */
export type CredentialScope = string & { readonly [__credentialScope]: true };

/**
 * A group's folder name used as the engine's primary scope key.
 * NOT directly assignable to CredentialScope — the two are deliberately incompatible.
 */
export type GroupScope = string & { readonly [__groupScope]: true };

/** Cast a string to GroupScope at a trust boundary (e.g. group.folder). */
export function asGroupScope(folder: string): GroupScope {
  return folder as unknown as GroupScope;
}

/** Cast a string to CredentialScope at a trust boundary (e.g. 'default'). */
export function asCredentialScope(scope: string): CredentialScope {
  return scope as unknown as CredentialScope;
}

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
  mode: 'token-exchange' | 'authorize-stub' | 'bearer-swap' | 'device-code';
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
  /** How bearer-swap handles expired tokens. */
  refreshStrategy: RefreshStrategy;
  /**
   * Env var → token role mapping for container provisioning.
   * E.g. { "GH_TOKEN": "access", "ANTHROPIC_API_KEY": "api_key" }
   * During provision, each role's substitute is looked up and set as the env var.
   */
  envVars?: Record<string, string>;
  /**
   * Controls which fields are captured from token-exchange requests/responses
   * and stored alongside tokens for use in refresh requests.
   *
   * Default (no config): auto-captures non-transient fields from request body,
   * and `scope` from response body.
   *
   * Setting `fromRequest` or `fromResponse` disables auto-capture for that
   * direction and captures only the listed fields.
   *
   * `scopeExclude`/`scopeInclude` are always applied to the final `scope` value.
   */
  tokenFieldCapture?: {
    fromRequest?: string[];
    fromResponse?: string[];
    scopeExclude?: string[];
    scopeInclude?: string[];
  };
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
// Well-known credential path constants
// ---------------------------------------------------------------------------

/** Credential path for OAuth access tokens. */
export const CRED_OAUTH = 'oauth';

/** Credential path for OAuth refresh tokens (nested under 'oauth'). */
export const CRED_OAUTH_REFRESH = 'oauth/refresh';

// ---------------------------------------------------------------------------
// Token substitute mapping (stored by the engine — no credentials)
// ---------------------------------------------------------------------------

/**
 * Per-substitute metadata. Stored inside ProviderSubstitutes.
 * Does not carry providerId or scope — those are the map keys above it.
 */
export interface SubstituteEntry {
  /** Path to the token within the keys file, e.g. 'oauth', 'api_key', 'oauth/refresh'. */
  credentialPath: string;
  scopeAttrs: Record<string, string>;
  /** Per-entry source scope for borrowed credentials. Absent = owned by this group. */
  sourceScope?: CredentialScope;
}

/**
 * All substitutes for one provider within one group scope.
 * Cross-scope borrowing is tracked per-entry via SubstituteEntry.sourceScope.
 */
export interface ProviderSubstitutes {
  substitutes: Map<string, SubstituteEntry>;
}

/**
 * Runtime access check: can this group still access credentials from sourceScope?
 * Checked on substitute resolution and refresh. If denied, the substitute is
 * revoked (on read) or promoted to own scope (on refresh).
 */
export type ScopeAccessCheck = (
  groupScope: GroupScope,
  sourceScope: CredentialScope,
) => boolean;

/**
 * Public return type of resolveSubstitute. Reconstructed from the engine's
 * internal ProviderSubstitutes structure.
 * credentialScope = effective scope where the real token lives
 *   (sourceScope if borrowed, groupScope if own).
 */
export interface SubstituteMapping {
  providerId: string;
  /** Path to the token: 'oauth', 'api_key', 'oauth/refresh', etc. */
  credentialPath: string;
  scopeAttrs: Record<string, string>;
  credentialScope: CredentialScope;
}

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

export interface AuthToken {
  value: string; // encrypted on disk and in cache; resolve() decrypts, store() accepts plaintext
  expires_ts: number; // epoch ms, 0 = no expiry
  authFields?: Record<string, string>; // captured fields for refresh (client_id, scope, etc.)
}

/** A stored credential with optional nested refresh token. */
export interface Credential extends AuthToken {
  updated_ts: number; // epoch ms
  /** Nested refresh token — only present for OAuth credentials. */
  refresh?: {
    value: string; // encrypted on disk and in cache; resolve() decrypts, store() accepts plaintext
    expires_ts: number;
    updated_ts: number;
  };
}

// ---------------------------------------------------------------------------
// Credential resolver interface
// ---------------------------------------------------------------------------

/**
 * Pluggable credential store. Keyed by (credentialScope, providerId, credentialId).
 * credentialId is a top-level identity ('oauth', 'api_key') — never a path.
 * The engine handles credentialPath parsing (e.g. 'oauth/refresh') above this layer.
 */
export interface CredentialResolver {
  /** Store or update a credential (hot cache + disk). Accepts plaintext values. */
  store(
    providerId: string,
    credentialScope: CredentialScope,
    credentialId: string,
    credential: Credential,
  ): void;

  /**
   * Resolve from cache. Returns a Credential with decrypted plaintext values.
   * Safe to read fields directly or pass back to store() without double-encryption.
   */
  resolve(
    credentialScope: CredentialScope,
    providerId: string,
    credentialId: string,
  ): Credential | null;

  /**
   * Extract a token value from a resolved (plaintext) Credential.
   * Without subPath: returns credential.value.
   * With subPath (e.g. 'refresh'): returns the nested sub-token's value.
   */
  extractToken(credential: Credential, subPath?: string): string | null;

  /** Delete credential from both cache and disk. */
  delete(credentialScope: CredentialScope, providerId?: string): void;
}

/** @deprecated Use CredentialResolver. */
export type TokenResolver = CredentialResolver;

// ---------------------------------------------------------------------------
// Refresh strategy for bearer-swap 401/403 handling
// ---------------------------------------------------------------------------

export type RefreshStrategy = 'redirect' | 'buffer' | 'passthrough';
