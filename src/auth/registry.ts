/**
 * Credential provider registry — same pattern as channels/registry.ts.
 * When a provider has hostRules, they're registered with the credential proxy.
 */
import type { CredentialProvider } from './types.js';
import { getProxy } from '../credential-proxy.js';

const registry = new Map<string, CredentialProvider>();

export function registerProvider(provider: CredentialProvider): void {
  registry.set(provider.service, provider);
  // Register host rules for transparent proxy routing
  if (provider.hostRules) {
    const proxy = getProxy();
    for (const rule of provider.hostRules) {
      proxy.registerProviderHost(rule.hostPattern, rule.pathPattern, rule.handler);
    }
  }
}

export function getProvider(service: string): CredentialProvider | undefined {
  return registry.get(service);
}

export function getAllProviders(): CredentialProvider[] {
  return [...registry.values()];
}
