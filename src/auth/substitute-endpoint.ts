/**
 * GET /credentials/<providerId>/substitute?path=<credentialPath>[&envVar=<name>]
 *
 * Lets a running container pull a substitute token for a provider whose
 * credentials were added after the container started, or for providers
 * without an _env_vars mapping. The proxy identifies the caller by IP
 * and resolves the group scope automatically.
 *
 * Optional `envVar` query parameter: register an additional env var name
 * for this substitute. Validated against a deny-list of reserved names.
 *
 * Response (200):
 *   { "substitute": "ghp_xxxx...", "providerId": "github", "credentialPath": "oauth", "envNames": ["GH_TOKEN"] }
 *
 * Response (404): credential not found for this scope/provider.
 * Response (400): missing or invalid providerId, or invalid envVar name.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { GroupScope } from './oauth-types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from './oauth-types.js';
import { getTokenEngine } from './registry.js';
import { getDiscoveryProvider, getProvider } from './registry.js';
import { validateEnvVarName } from './docker-env.js';
import { logger } from '../logger.js';

// ── Handler ───────────────────────────────────────────────────────

export function handleSubstituteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): void {
  // Parse /credentials/<providerId>/substitute?path=<credentialPath>[&envVar=<name>]
  const url = new URL(req.url || '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  // Expected: ['credentials', '<providerId>', 'substitute']
  if (segments.length !== 3 || segments[0] !== 'credentials' || segments[2] !== 'substitute') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected /credentials/<providerId>/substitute' }));
    return;
  }

  const providerId = decodeURIComponent(segments[1]);
  const credentialPath = url.searchParams.get('path');
  if (!credentialPath) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required query parameter: path (e.g. ?path=oauth or ?path=api_key)' }));
    return;
  }

  // Validate optional envVar parameter
  const envVarParam = url.searchParams.get('envVar');
  if (envVarParam) {
    const err = validateEnvVarName(envVarParam);
    if (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err }));
      return;
    }
  }

  // Look up provider config to get substituteConfig and envVars
  const discovery = getDiscoveryProvider(providerId);
  const builtin = getProvider(providerId);
  const substituteConfig = discovery?.substituteConfig ?? DEFAULT_SUBSTITUTE_CONFIG;

  if (!discovery && !builtin) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown provider: ${providerId}` }));
    return;
  }

  // Build envNames: discovery defaults + optional envVar param
  const envNames: string[] = [];
  if (discovery?.envVars) {
    for (const [envName, declaredPath] of Object.entries(discovery.envVars)) {
      if (declaredPath === credentialPath) {
        envNames.push(envName);
      }
    }
  }
  if (envVarParam && !envNames.includes(envVarParam)) {
    envNames.push(envVarParam);
  }

  const engine = getTokenEngine();
  const substitute = engine.getOrCreateSubstitute(
    providerId, {}, scope, substituteConfig, credentialPath,
    envNames.length > 0 ? envNames : undefined,
  );

  if (!substitute) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: `No credentials found for provider '${providerId}' (path: ${credentialPath}) in scope '${scope}'`,
    }));
    return;
  }

  // If envVar param was provided and substitute already existed, merge it in
  if (envVarParam) {
    engine.mergeEnvNames(scope, providerId, substitute, [envVarParam]);
  }

  logger.info(
    { providerId, credentialPath, scope, envNames },
    'Served substitute token to container',
  );

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    substitute,
    providerId,
    credentialPath,
    envNames,
  }));
}
