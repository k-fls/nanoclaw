/**
 * Credential provider registry — same pattern as channels/registry.ts.
 * When a provider has hostRules, they're registered with the credential proxy.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import type { CredentialProvider } from './types.js';
import { getProxy } from '../credential-proxy.js';
import { loadDiscoveryProviders } from './discovery-loader.js';
import { TokenSubstituteEngine, InMemoryTokenResolver } from './token-substitute.js';
import { createHandler, registerCredentialProvider } from './universal-oauth-handler.js';
import { logger } from '../logger.js';

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

// ---------------------------------------------------------------------------
// Discovery-file provider registration
// ---------------------------------------------------------------------------

/** Shared token resolver — owns real token storage. */
let _tokenResolver: InMemoryTokenResolver | null = null;

/** Shared token substitute engine — one instance for all discovery providers. */
let _tokenEngine: TokenSubstituteEngine | null = null;

export function getTokenResolver(): InMemoryTokenResolver {
  if (!_tokenResolver) _tokenResolver = new InMemoryTokenResolver();
  return _tokenResolver;
}

export function getTokenEngine(): TokenSubstituteEngine {
  if (!_tokenEngine) _tokenEngine = new TokenSubstituteEngine(getTokenResolver());
  return _tokenEngine;
}

/**
 * Load discovery files and register their intercept rules with the proxy.
 * Called once at startup, after registerBuiltinProviders() so built-in
 * rules take priority (matchHostRule uses first-match via find()).
 */
export function registerDiscoveryProviders(discoveryDir?: string): void {
  const dir = discoveryDir ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../docs/oauth-discovery',
  );

  const providers = loadDiscoveryProviders(dir);
  const tokenEngine = getTokenEngine();
  const proxy = getProxy();

  let ruleCount = 0;
  for (const [_id, provider] of providers) {
    for (const rule of provider.rules) {
      const hostPattern = rule.hostPattern ?? new RegExp(`^${rule.anchor.replace(/\./g, '\\.')}$`);
      const handler = createHandler(provider, rule, tokenEngine);

      proxy.registerAnchoredRule(rule.anchor, hostPattern, rule.pathPattern, handler);
      ruleCount++;
    }
  }

  logger.info(
    { providers: providers.size, rules: ruleCount },
    'Registered discovery OAuth providers',
  );
}

/**
 * Wire a CredentialProvider to the universal handler's refresh lookup.
 * Call this for each built-in provider whose refresh() should be available
 * to discovery-file handlers (e.g. if Claude is later migrated).
 */
export function wireCredentialProviderRefresh(
  providerId: string,
  provider: CredentialProvider,
): void {
  registerCredentialProvider(providerId, provider);
}
