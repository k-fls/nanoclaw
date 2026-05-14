/**
 * Auth barrel — re-exports and registers built-in providers.
 */
export { initCredentialStore } from './store.js';
export { importEnvToMainGroup } from './provision.js';
export { createAuthGuard, type AuthGuard } from './guard.js';
export {
  registerProvider,
  getProvider,
  getAllProviders,
  registerDiscoveryProviders,
  getTokenEngine,
  getTokenResolver,
} from './registry.js';

// Register built-in providers — must be called after setProxyInstance()
// since registration requires the proxy for host rule setup.
import { registerProvider, registerClaudeUniversalRules } from './registry.js';
import { claudeProvider } from './providers/claude.js';

export function registerBuiltinProviders(): void {
  // Register in the provider registry (for provision, auth options, etc.)
  registerProvider(claudeProvider);
  // Register Claude's intercept rules via the universal handler
  registerClaudeUniversalRules(claudeProvider);
}
