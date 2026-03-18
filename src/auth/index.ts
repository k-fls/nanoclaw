/**
 * Auth barrel — re-exports and registers built-in providers.
 */
export { initCredentialStore } from './store.js';
export { resolveSecrets } from './provision.js';
export { importEnvToDefault } from './provision.js';
export { createAuthGuard } from './guard.js';
export { registerProvider, getProvider, getAllProviders } from './registry.js';

// Register built-in providers — must be called after setProxyInstance()
// since registerProvider() registers host rules on the proxy.
import { registerProvider } from './registry.js';
import { claudeProvider } from './providers/claude.js';

export function registerBuiltinProviders(): void {
  registerProvider(claudeProvider);
}
