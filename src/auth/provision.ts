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
  asCredentialScope,
} from './oauth-types.js';
import type {
  TokenSubstituteEngine,
  GroupResolver,
} from './token-substitute.js';

/**
 * Import .env values into the main group's scope via each provider's importEnv().
 * Called once at startup. Skips providers that already have keys stored.
 */
export function importEnvToMainGroup(
  engine: TokenSubstituteEngine,
  mainGroupFolder: string,
): void {
  const mainScope = asGroupScope(mainGroupFolder);
  const mainCredScope = asCredentialScope(mainGroupFolder);
  for (const provider of getAllProviders()) {
    if (engine.hasAnyCredential(mainScope, provider.id)) continue;
    provider.importEnv?.(mainCredScope, engine.storeCredential.bind(engine));
  }
}

/**
 * Create a ScopeAccessCheck callback that uses a group resolver.
 * The returned function checks whether a group is allowed to access
 * credentials from the given sourceScope.
 */
/**
 * Provision env vars from an OAuthProvider's envVars mapping.
 * Each env var maps to a credentialPath (e.g. 'oauth', 'api_key').
 * Skips absent credentials silently — no env var emitted if no token exists.
 */
export function provisionEnvVars(
  oauthProvider: OAuthProvider,
  group: RegisteredGroup,
  tokenEngine: TokenSubstituteEngine,
): Record<string, string> {
  if (!oauthProvider.envVars) return {};

  const scope = scopeOf(group);
  const env: Record<string, string> = {};

  for (const [envName, credentialPath] of Object.entries(oauthProvider.envVars)) {
    const sub = tokenEngine.getOrCreateSubstitute(
      oauthProvider.id,
      {},
      scope,
      oauthProvider.substituteConfig,
      credentialPath,
    );
    if (sub) env[envName] = sub;
  }

  return env;
}

export function createAccessCheck(
  groupResolver: GroupResolver,
): ScopeAccessCheck {
  return (groupScope: GroupScope, sourceScope: CredentialScope): boolean => {
    // Own scope: always allowed
    if ((groupScope as string) === (sourceScope as string)) return true;

    const borrower = groupResolver(groupScope);
    if (!borrower) return false;

    // Borrower must claim this source
    if (borrower.containerConfig?.credentialSource !== (sourceScope as string))
      return false;

    // Grantor must have listed this borrower
    const grantor = groupResolver(asGroupScope(sourceScope as string));
    if (!grantor) return false;
    return (
      grantor.containerConfig?.credentialGrantees?.includes(
        groupScope as string,
      ) === true
    );
  };
}
