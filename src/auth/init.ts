/**
 * Auth system initialization — extracted from index.ts to reduce
 * footprint in the core orchestrator file.
 *
 * initAuthSystem() sets up the credential proxy, registers providers,
 * wires the token engine, and starts the proxy server. index.ts calls
 * it once during startup and receives the tokenEngine + shutdown hook.
 */
import { CREDENTIAL_PROXY_PORT } from '../config.js';
import { setInteractionPrefix } from '../interaction/index.js';
import { registerAuthHandlers } from './auth-handlers.js';
import { DISCOVERY_CACHE_DIR } from './store.js';
import { getDiscoveryDir } from './registry.js';
import { refreshDiscoveryCache } from './discovery-refresh.js';
import {
  CredentialProxy,
  setProxyInstance,
  getProxy,
} from './credential-proxy.js';
import { PROXY_BIND_HOST, ensureNetwork } from './container-args.js';
import { initCredentialStore } from './store.js';
import { importEnvToMainGroup } from './provision.js';
import {
  registerBuiltinProviders,
  registerDiscoveryProviders,
  getTokenEngine,
} from './index.js';
import { createAccessCheck } from './provision.js';
import {
  setManifestGroupResolver,
  regenerateAllManifests,
} from './manifest.js';
import { wireAuthCallbacks } from './oauth-flow.js';
import type { TokenSubstituteEngine, GroupResolver } from './token-substitute.js';
import { scopeOf, type RegisteredGroup } from '../types.js';
import type { Server as NetServer } from 'net';
import { logger } from '../logger.js';
import { asCredentialScope } from './oauth-types.js';

export interface AuthSystem {
  tokenEngine: TokenSubstituteEngine;
  proxyServer: NetServer;
  shutdown: () => void;
}

/**
 * Initialize the full auth/credential proxy system.
 *
 * @param getGroups - callback returning current registered groups (avoids
 *   coupling to index.ts module state)
 */
export async function initAuthSystem(
  getGroups: () => Record<string, RegisteredGroup>,
  resolveGroup: GroupResolver,
): Promise<AuthSystem> {
  setInteractionPrefix('🤖');
  registerAuthHandlers();
  initCredentialStore();
  ensureNetwork();

  // Create and initialize the credential proxy instance.
  // Must happen before registerProvider() calls so providers can register host rules.
  const proxy = new CredentialProxy();
  setProxyInstance(proxy);

  // Activate proxy tap logger if PROXY_TAP_DOMAIN + PROXY_TAP_PATH are set
  const { createTapFilterFromEnv } = await import('./proxy-tap-logger.js');
  const tapFilter = createTapFilterFromEnv();
  if (tapFilter) proxy.setTapFilter(tapFilter);

  // Register built-in auth providers first (takes priority in first-match dispatch),
  // then discovery-file providers to fill gaps for other OAuth services.
  registerBuiltinProviders();
  registerDiscoveryProviders(undefined, DISCOVERY_CACHE_DIR);

  // Wire token engine with group resolver and access check.
  // Must happen after providers are registered and before any provision calls.
  const tokenEngine = getTokenEngine();


  tokenEngine.setGroupResolver(resolveGroup);
  tokenEngine.setAccessCheck(createAccessCheck(resolveGroup));
  setManifestGroupResolver(resolveGroup);

  // Regenerate all manifests at startup
  regenerateAllManifests();

  // Import .env credentials into main group's scope
  const mainGroup = Object.values(getGroups()).find((g) => g.isMain);
  if (mainGroup) {
    importEnvToMainGroup(tokenEngine, asCredentialScope(scopeOf(mainGroup)));
  }

  // Wire auth error resolver, OAuth initiation, and browser-open callbacks
  wireAuthCallbacks(proxy);

  // Register additional Claude hosts from ANTHROPIC_BASE_URL if configured
  {
    const envVars = await import('../env.js').then((m) =>
      m.readEnvFile(['ANTHROPIC_BASE_URL']),
    );
    if (envVars.ANTHROPIC_BASE_URL) {
      const { registerClaudeBaseUrl } = await import('./providers/claude.js');
      const { createHandler } = await import('./universal-oauth-handler.js');
      const { getTokenEngine } = await import('./registry.js');
      registerClaudeBaseUrl(
        envVars.ANTHROPIC_BASE_URL,
        getTokenEngine(),
        createHandler,
      );
    }
  }

  // Start credential proxy — handles transparent TLS (iptables redirect),
  // explicit HTTP/HTTPS proxy (CONNECT), and internal endpoints.
  const proxyServer = await proxy.start({
    port: CREDENTIAL_PROXY_PORT,
    host: PROXY_BIND_HOST,
    enableTransparent: true,
  });

  logger.info(
    { port: CREDENTIAL_PROXY_PORT, host: PROXY_BIND_HOST },
    'Auth system initialized',
  );

  // Refresh discovery cache in the background (non-blocking, startup only).
  refreshDiscoveryCache(getDiscoveryDir(), DISCOVERY_CACHE_DIR).catch((err) => {
    logger.warn({ err }, 'Discovery refresh failed');
  });

  return {
    tokenEngine,
    proxyServer,
    shutdown: () => proxyServer.close(),
  };
}

