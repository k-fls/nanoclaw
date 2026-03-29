/**
 * Types for the universal OAuth provider system.
 *
 * Discovery-file-driven proxy rules: adding a provider = dropping a JSON file
 * in docs/oauth-discovery/. These types describe the parsed result.
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

/** The shared credential scope used by main and groups with useDefaultCredentials. */
export const DEFAULT_CREDENTIAL_SCOPE: CredentialScope =
  asCredentialScope('default');

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
// Token substitute mapping (stored by the engine — no credentials)
// ---------------------------------------------------------------------------

/**
 * Per-substitute metadata. Stored inside ProviderSubstitutes.
 * Does not carry providerId or scope — those are the map keys above it.
 */
export interface SubstituteEntry {
  role: string;
  scopeAttrs: Record<string, string>;
}

/**
 * All substitutes for one provider within one group scope.
 * sourceScope tracks cross-scope credential borrowing:
 *   - absent (undefined) = credentials belong to this group's own scope
 *   - present = credentials are borrowed from another scope (e.g. 'default')
 */
export interface ProviderSubstitutes {
  sourceScope?: CredentialScope;
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
  role: string;
  scopeAttrs: Record<string, string>;
  credentialScope: CredentialScope;
}

/**
 * Pluggable credential store interface. The engine delegates real-token
 * storage and retrieval to this — it never holds credentials itself.
 * Credentials are keyed by (credentialScope, providerId, role).
 */
export interface TokenResolver {
  /** Store (or update) a real token. */
  store(
    realToken: string,
    providerId: string,
    credentialScope: CredentialScope,
    role?: string,
    expiresTs?: number,
    authFields?: Record<string, string>,
  ): void;
  /** Retrieve the current real token. Returns null if not found or revoked. */
  resolve(
    credentialScope: CredentialScope,
    providerId: string,
    role: string,
  ): string | null;
  /** Remove all tokens for a scope (and optionally a provider). */
  revoke(credentialScope: CredentialScope, providerId?: string): void;
}

// ---------------------------------------------------------------------------
// Refresh strategy for bearer-swap 401/403 handling
// ---------------------------------------------------------------------------

export type RefreshStrategy =
  | 'redirect'
  | 'buffer'
  | 'passthrough'
  | 'proactive';
