/**
 * Scope resolution for container secrets.
 * Replaces readSecrets() in container-runner.ts.
 *
 * Resolution order:
 * 1. credentials/{group.folder}/ (group-specific)
 * 2. credentials/default/ (if group is allowed via useDefaultCredentials)
 */
import type { RegisteredGroup } from '../types.js';
import { getAllProviders } from './registry.js';

/**
 * Import .env values into the default scope via each provider's importEnv().
 * Called once at startup. Each provider decides whether to skip if already present.
 */
export function importEnvToDefault(): void {
  for (const provider of getAllProviders()) {
    provider.importEnv?.('default');
  }
}

/** Resolve which scope holds credentials for this group. */
export function resolveScope(group: RegisteredGroup): string {
  const providers = getAllProviders();
  const useDefault = group.containerConfig?.useDefaultCredentials
    ?? (group.isMain === true);

  // Group scope wins if any provider has credentials there
  if (providers.some(p => p.hasValidCredentials(group.folder))) return group.folder;
  if (useDefault && providers.some(p => p.hasValidCredentials('default'))) return 'default';
  return group.folder;
}
