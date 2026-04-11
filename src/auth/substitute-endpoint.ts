/**
 * GET /credentials/<providerId>/substitute?path=<credentialPath>
 *
 * Lets a running container pull a substitute token for a provider whose
 * credentials were added after the container started, or for providers
 * without an _env_vars mapping. The proxy identifies the caller by IP
 * and resolves the group scope automatically.
 *
 * Response (200):
 *   { "substitute": "ghp_xxxx...", "providerId": "github", "credentialPath": "oauth", "envVars": { "GH_TOKEN": "ghp_xxxx..." } }
 *
 * Response (404): credential not found for this scope/provider.
 * Response (400): missing or invalid providerId.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { GroupScope } from './oauth-types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from './oauth-types.js';
import { getTokenEngine } from './registry.js';
import { getDiscoveryProvider, getProvider } from './registry.js';
import { logger } from '../logger.js';

export function handleSubstituteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): void {
  // Parse /credentials/<providerId>/substitute?path=<credentialPath>
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

  // Look up provider config to get substituteConfig and envVars
  const discovery = getDiscoveryProvider(providerId);
  const builtin = getProvider(providerId);
  const substituteConfig = discovery?.substituteConfig ?? DEFAULT_SUBSTITUTE_CONFIG;

  if (!discovery && !builtin) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown provider: ${providerId}` }));
    return;
  }

  const engine = getTokenEngine();
  const substitute = engine.getOrCreateSubstitute(
    providerId, {}, scope, substituteConfig, credentialPath,
  );

  if (!substitute) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: `No credentials found for provider '${providerId}' (path: ${credentialPath}) in scope '${scope}'`,
    }));
    return;
  }

  // Build env var mapping if the discovery file declares one
  const envVars: Record<string, string> = {};
  if (discovery?.envVars) {
    for (const [envName, declaredPath] of Object.entries(discovery.envVars)) {
      if (declaredPath === credentialPath) {
        envVars[envName] = substitute;
      }
    }
  }

  logger.info(
    { providerId, credentialPath, scope },
    'Served substitute token to container',
  );

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    substitute,
    providerId,
    credentialPath,
    envVars,
  }));
}
