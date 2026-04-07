/**
 * Credential provider registry — same pattern as channels/registry.ts.
 * When a provider has hostRules, they're registered with the credential proxy.
 *
 * Claude is registered programmatically through the universal handler system,
 * with a wrapper for x-api-key support. Discovery-file providers fill gaps
 * for other OAuth services.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { CredentialProvider } from './types.js';
import { getProxy } from './credential-proxy.js';
import { loadDiscoveryProviders } from './discovery-loader.js';
import type { OAuthProvider } from './oauth-types.js';
import {
  TokenSubstituteEngine,
  PersistentCredentialResolver,
} from './token-substitute.js';
import { CREDENTIALS_DIR } from './store.js';
import { createHandler } from './universal-oauth-handler.js';
import { registerAuthorizationEndpoint } from './browser-open-handler.js';
import {
  CLAUDE_OAUTH_PROVIDER,
  PROVIDER_ID as CLAUDE_PROVIDER_ID,
  migrateClaudeCredentials,
} from './providers/claude.js';
import { logger } from '../logger.js';

const registry = new Map<string, CredentialProvider>();

export function registerProvider(provider: CredentialProvider): void {
  registry.set(provider.id, provider);
  // Register host rules for transparent proxy routing
  if (provider.hostRules) {
    const proxy = getProxy();
    for (const rule of provider.hostRules) {
      proxy.registerProviderHost(
        rule.hostPattern,
        rule.pathPattern,
        rule.handler,
        provider.id,
      );
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
// Discovery provider map (retained at module level for key management)
// ---------------------------------------------------------------------------

let _discoveryProviders = new Map<string, OAuthProvider>();
let _discoveryDir = '';

export function getDiscoveryProvider(id: string): OAuthProvider | undefined {
  return _discoveryProviders.get(id);
}

export function getDiscoveryDir(): string {
  return _discoveryDir;
}

export function getAllDiscoveryProviderIds(): string[] {
  return [..._discoveryProviders.keys()];
}

/** Check if a provider ID is registered (builtin or discovery). */
export function isKnownProvider(id: string): boolean {
  return registry.has(id) || _discoveryProviders.has(id);
}

/**
 * Parse a tap exclude specification.
 * @param raw  Comma-separated provider IDs, empty string for no exclusions,
 *             or undefined to apply the default (claude).
 * @returns { excluded, unknown } — validated set and any unrecognised IDs.
 */
export function parseTapExclude(raw: string | undefined): {
  excluded: Set<string>;
  unknown: string[];
} {
  if (raw === undefined) {
    return { excluded: new Set([CLAUDE_PROVIDER_ID]), unknown: [] };
  }
  const ids = raw.split(',').filter(Boolean);
  const excluded = new Set<string>();
  const unknown: string[] = [];
  for (const id of ids) {
    if (isKnownProvider(id)) {
      excluded.add(id);
    } else {
      unknown.push(id);
    }
  }
  return { excluded, unknown };
}

// ---------------------------------------------------------------------------
// Token engine (shared across all providers)
// ---------------------------------------------------------------------------

/** Shared token resolver — owns real token storage with persistence. */
let _tokenResolver: PersistentCredentialResolver | null = null;

/** Shared token substitute engine — one instance for all providers. */
let _tokenEngine: TokenSubstituteEngine | null = null;

export function getTokenResolver(): PersistentCredentialResolver {
  if (!_tokenResolver) _tokenResolver = new PersistentCredentialResolver();
  return _tokenResolver;
}

export function getTokenEngine(): TokenSubstituteEngine {
  if (!_tokenEngine) {
    _tokenEngine = new TokenSubstituteEngine(getTokenResolver());
    // Migrate old claude_auth.json → claude.keys.json for all scopes
    // Must run before loadAllPersistedRefs so keys files exist for ref loading.
    migrateAllScopes();
    // Load persisted substitute→identity mappings from previous runs
    const loaded = _tokenEngine.loadAllPersistedRefs();
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded persisted substitute refs');
    }
  }
  return _tokenEngine;
}

/**
 * Run migrateClaudeCredentials for every scope directory in the credentials store.
 * Converts claude_auth.json → claude.keys.json if not already migrated.
 */
function migrateAllScopes(): void {
  try {
    if (!fs.existsSync(CREDENTIALS_DIR)) return;
    for (const entry of fs.readdirSync(CREDENTIALS_DIR, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      migrateClaudeCredentials(entry.name);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to migrate credential scopes');
  }
}

/** @internal Override the token engine (for e2e tests). */
export function setTokenEngine(engine: TokenSubstituteEngine): void {
  _tokenEngine = engine;
}

// ---------------------------------------------------------------------------
// Claude provider registration (programmatic, not discovery-file)
// ---------------------------------------------------------------------------

/**
 * Register Claude's intercept rules through the universal handler.
 * Called from registerBuiltinProviders() after the proxy is initialized.
 *
 * Claude gets special treatment:
 *   - api.anthropic.com bearer-swap is wrapped with x-api-key support
 *   - Claude's refresh() is wired to the universal handler's refresh lookup
 *   - Token exchange at platform.claude.com uses the universal handler as-is
 */
function registerClaudeUniversalRules(provider: CredentialProvider): void {
  const tokenEngine = getTokenEngine();
  const proxy = getProxy();

  // Register Claude's authorization endpoint for browser-open detection
  registerAuthorizationEndpoint('https://claude.ai/oauth/authorize', 'claude');

  for (const rule of CLAUDE_OAUTH_PROVIDER.rules) {
    const hostPattern = new RegExp(`^${rule.anchor.replace(/\./g, '\\.')}$`);
    const handler = createHandler(CLAUDE_OAUTH_PROVIDER, rule, tokenEngine);

    proxy.registerAnchoredRule(
      rule.anchor,
      hostPattern,
      rule.pathPattern,
      handler,
      CLAUDE_OAUTH_PROVIDER.id,
    );
  }

  logger.info('Registered Claude provider via universal handler');
}

// ---------------------------------------------------------------------------
// Discovery-file provider registration
// ---------------------------------------------------------------------------

/**
 * Load discovery files and register their intercept rules with the proxy.
 * Called once at startup, after registerBuiltinProviders() so built-in
 * rules take priority (matchHostRule uses first-match via find()).
 */
export function registerDiscoveryProviders(
  discoveryDir?: string,
  cacheDir?: string,
): void {
  const dir =
    discoveryDir ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/auth/oauth-discovery',
    );

  _discoveryDir = dir;
  const { providers, rawData } = loadDiscoveryProviders(dir, cacheDir);
  _discoveryProviders = providers;
  const tokenEngine = getTokenEngine();
  const proxy = getProxy();

  // Register authorization_endpoint patterns for browser-open detection
  // using merged raw data (no second file read needed)
  for (const [providerId, data] of rawData) {
    if (
      data.authorization_endpoint &&
      typeof data.authorization_endpoint === 'string'
    ) {
      registerAuthorizationEndpoint(data.authorization_endpoint, providerId);
    }
  }

  let ruleCount = 0;
  for (const [_id, provider] of providers) {
    for (const rule of provider.rules) {
      const hostPattern =
        rule.hostPattern ??
        new RegExp(`^${rule.anchor.replace(/\./g, '\\.')}$`);
      const handler = createHandler(provider, rule, tokenEngine);

      proxy.registerAnchoredRule(
        rule.anchor,
        hostPattern,
        rule.pathPattern,
        handler,
        provider.id,
      );
      ruleCount++;
    }
  }

  logger.info(
    { providers: providers.size, rules: ruleCount },
    'Registered discovery OAuth providers',
  );
}

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register Claude with the universal handler system.
 * Exported so auth/index.ts can call it from registerBuiltinProviders().
 */
export { registerClaudeUniversalRules };
