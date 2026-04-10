/**
 * Credential provisioning helpers.
 *
 * importEnvCredentials() — read .env values into credential store by mapping.
 * provisionFromMapping() — produce container env vars from stored credentials.
 * importEnvToMainGroup() — bootstrap .env credentials at startup.
 * createAccessCheck() — access check callback for the token engine.
 */
import type { RegisteredGroup } from '../types.js';
import { scopeOf } from '../types.js';
import { getAllProviders } from './registry.js';
import type {
  Credential,
  OAuthProvider,
  SubstituteConfig,
  ScopeAccessCheck,
  GroupScope,
  CredentialScope,
} from './oauth-types.js';
import { asGroupScope, asCredentialScope } from './oauth-types.js';
import type {
  TokenSubstituteEngine,
  GroupResolver,
} from './token-substitute.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Reusable env ↔ creds helpers
// ---------------------------------------------------------------------------

/**
 * Import credentials from .env by a declared mapping.
 * Reads env vars, skips if a substitute already exists for that credentialPath,
 * stores the credential, and logs each import.
 *
 * @returns Set of credentialPaths that were imported.
 */
export function importEnvCredentials(
  mapping: Record<string, string>,
  providerId: string,
  credScope: CredentialScope,
  engine: TokenSubstituteEngine,
  buildCredential?: (envValue: string, credentialPath: string) => Credential,
): Set<string> {
  const envVarNames = Object.keys(mapping);
  if (envVarNames.length === 0) return new Set();

  const envValues = readEnvFile(envVarNames);
  const groupScope = asGroupScope(credScope);
  const imported = new Set<string>();

  for (const [envName, credentialPath] of Object.entries(mapping)) {
    const value = envValues[envName];
    if (!value) continue;
    if (imported.has(credentialPath)) continue; // first env var wins for same path

    // Skip if a substitute already exists (credential already stored)
    if (engine.getSubstitute(providerId, groupScope, credentialPath) !== null) {
      continue;
    }

    const credential = buildCredential
      ? buildCredential(value, credentialPath)
      : { value, expires_ts: 0, updated_ts: Date.now() };

    engine.storeCredential(providerId, credScope, credentialPath, credential);
    imported.add(credentialPath);

    logger.info(
      { providerId, credScope, envVar: envName, credentialPath },
      'Imported .env credential',
    );
  }

  return imported;
}

/**
 * Produce container env vars from stored credentials using a declared mapping.
 * For each envVar → credentialPath, calls getOrCreateSubstitute and sets
 * the env var to the substitute token.
 */
export function provisionFromMapping(
  mapping: Record<string, string>,
  providerId: string,
  groupScope: GroupScope,
  config: SubstituteConfig,
  engine: TokenSubstituteEngine,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [envName, credentialPath] of Object.entries(mapping)) {
    const sub = engine.getOrCreateSubstitute(
      providerId, {}, groupScope, config, credentialPath,
    );
    if (sub) env[envName] = sub;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Startup + provision wrappers
// ---------------------------------------------------------------------------

/**
 * Import .env values into the main group's scope via each provider's importEnv().
 * Called once at startup.
 */
export function importEnvToMainGroup(
  engine: TokenSubstituteEngine,
  credScope: CredentialScope,
): void {
  for (const provider of getAllProviders()) {
    provider.importEnv?.(credScope, engine);
  }
}

/**
 * Provision env vars from an OAuthProvider's envVars mapping.
 * Thin wrapper over provisionFromMapping for discovery providers.
 */
export function provisionEnvVars(
  oauthProvider: OAuthProvider,
  group: RegisteredGroup,
  tokenEngine: TokenSubstituteEngine,
): Record<string, string> {
  if (!oauthProvider.envVars) return {};
  return provisionFromMapping(
    oauthProvider.envVars,
    oauthProvider.id,
    scopeOf(group),
    oauthProvider.substituteConfig,
    tokenEngine,
  );
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
      grantor.containerConfig?.credentialGrantees?.has(
        groupScope as string,
      ) === true
    );
  };
}
