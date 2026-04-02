/**
 * Credential provisioning helpers.
 *
 * importEnvToDefault() — bootstrap .env credentials at startup.
 * canAccessScope() — access check callback for the token engine.
 */
import type { RegisteredGroup } from '../types.js';
import { scopeOf } from '../types.js';
import { getAllProviders } from './registry.js';
import type {
  OAuthProvider,
  ScopeAccessCheck,
  GroupScope,
  CredentialScope,
} from './oauth-types.js';
import {
  asGroupScope,
  BEARER_SWAP_ROLES,
  DEFAULT_CREDENTIAL_SCOPE,
} from './oauth-types.js';
import type {
  TokenSubstituteEngine,
  TokenRole,
  GroupResolver,
} from './token-substitute.js';

/**
 * Import .env values into the default scope via each provider's importEnv().
 * Called once at startup. Skips providers that already have keys stored.
 */
export function importEnvToDefault(engine: TokenSubstituteEngine): void {
  for (const provider of getAllProviders()) {
    if (engine.hasAnyCredential(asGroupScope('default'), provider.id)) continue;
    provider.importEnv?.(DEFAULT_CREDENTIAL_SCOPE, engine.getResolver());
  }
}

/**
 * Create a ScopeAccessCheck callback that uses a group resolver.
 * The returned function checks whether a group is allowed to access
 * credentials from the given sourceScope.
 */
/**
 * Provision env vars from an OAuthProvider's envVars mapping.
 * Only populates vars for bearer-swap roles (access, api_key).
 * Skips absent roles silently — no env var emitted if no token exists.
 */
export function provisionEnvVars(
  oauthProvider: OAuthProvider,
  group: RegisteredGroup,
  tokenEngine: TokenSubstituteEngine,
): Record<string, string> {
  if (!oauthProvider.envVars) return {};

  const scope = scopeOf(group);
  const env: Record<string, string> = {};

  for (const [envName, role] of Object.entries(oauthProvider.envVars)) {
    if (!BEARER_SWAP_ROLES.has(role)) continue;
    const sub = tokenEngine.getOrCreateSubstitute(
      oauthProvider.id,
      {},
      scope,
      oauthProvider.substituteConfig,
      role as TokenRole,
    );
    if (sub) env[envName] = sub;
  }

  return env;
}

export function createAccessCheck(
  groupResolver: GroupResolver,
): ScopeAccessCheck {
  return (groupScope: GroupScope, sourceScope: CredentialScope): boolean => {
    if (sourceScope === 'default') {
      const group = groupResolver(groupScope);
      if (!group) return false;
      return (
        group.containerConfig?.useDefaultCredentials ?? group.isMain === true
      );
    }
    // Non-default sourceScope: only the group itself can access its own scope
    return (groupScope as string) === (sourceScope as string);
  };
}
