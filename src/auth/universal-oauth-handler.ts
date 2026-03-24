/**
 * Universal OAuth handler factory.
 *
 * Creates HostHandler functions for discovery-file providers.
 * Dispatches by InterceptRule.mode:
 *   - bearer-swap: swap Authorization header, pipe request, check response
 *     status before forwarding. On 401/403 with refresh available:
 *     strategy (a) 307 redirect, fallback (c) passthrough-with-hold.
 *   - token-exchange: reuse handleTokenExchange from oauth-interceptor.ts
 *   - authorize-stub: reuse handleAuthorizeStub from oauth-interceptor.ts
 */
import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'http';
import { request as httpsRequest, RequestOptions } from 'https';

import type { InterceptRule, OAuthProvider, RefreshStrategy } from './oauth-types.js';
import type { TokenSubstituteEngine } from './token-substitute.js';
import type { CredentialProvider } from './types.js';
import type { HostHandler } from '../credential-proxy.js';
import { proxyBuffered, setProxyResponseHook } from '../credential-proxy.js';
import { replaceJsonStringValue } from '../oauth-interceptor.js';
import { logger } from '../logger.js';

// Re-export setUpstreamAgent for test use
export { setUpstreamAgent } from '../credential-proxy.js';

// ---------------------------------------------------------------------------
// Provider registry for refresh lookups
// ---------------------------------------------------------------------------

/** Registry of credential providers, keyed by provider ID. */
const credentialProviders = new Map<string, CredentialProvider>();

/** Register a credential provider for refresh lookups. */
export function registerCredentialProvider(
  providerId: string,
  provider: CredentialProvider,
): void {
  credentialProviders.set(providerId, provider);
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

type HeaderMap = Record<string, string | number | string[] | undefined>;

function prepareHeaders(
  req: IncomingMessage,
  targetHost: string,
  contentLength?: number,
): HeaderMap {
  const headers: HeaderMap = {
    ...(req.headers as Record<string, string>),
    host: targetHost,
  };
  if (contentLength !== undefined) {
    headers['content-length'] = contentLength;
  }
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  return headers;
}

// ---------------------------------------------------------------------------
// Scope attribute extraction from hostname
// ---------------------------------------------------------------------------

function extractScopeAttrs(
  targetHost: string,
  rule: InterceptRule,
): Record<string, string> {
  if (!rule.hostPattern) return {};
  const match = rule.hostPattern.exec(targetHost);
  if (!match?.groups) return {};
  return { ...match.groups };
}

// ---------------------------------------------------------------------------
// Bearer-swap handler with 401 retry via 307 redirect
// ---------------------------------------------------------------------------

let _upstreamAgent: import('https').Agent | undefined;

/** Set the upstream HTTPS agent (for tests with self-signed certs). */
export function setTestUpstreamAgent(agent: import('https').Agent): void {
  _upstreamAgent = agent;
}

function createBearerSwapHandler(
  provider: OAuthProvider,
  rule: InterceptRule,
  tokenEngine: TokenSubstituteEngine,
  refreshStrategy: RefreshStrategy = 'redirect',
): HostHandler {
  return async (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetHost: string,
    targetPort: number,
    scope: string,
  ): Promise<void> => {
    const scopeAttrs = extractScopeAttrs(targetHost, rule);
    const headers = prepareHeaders(clientReq, targetHost);

    // Swap Bearer token
    let substitutedToken: string | null = null;
    const authHeader = headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      substitutedToken = authHeader.slice(7);
      const entry = tokenEngine.resolveWithRestriction(substitutedToken, scope, scopeAttrs);
      if (entry) {
        headers['authorization'] = `Bearer ${entry.realToken}`;
      }
      // If not resolved: pass through as-is (container's token hits upstream, gets 401)
    }

    // Send request upstream — DON'T pipe response yet, check status first
    await new Promise<void>((resolve) => {
      const upstream = httpsRequest(
        {
          hostname: targetHost,
          port: targetPort,
          path: clientReq.url,
          method: clientReq.method,
          headers,
          agent: _upstreamAgent,
        } as RequestOptions,
        async (upRes) => {
          const statusCode = upRes.statusCode!;

          // Happy path: not an auth error, pipe through
          if (statusCode !== 401 && statusCode !== 403) {
            clientRes.writeHead(statusCode, upRes.headers);
            upRes.pipe(clientRes);
            resolve();
            return;
          }

          // Auth error — attempt refresh
          const credProvider = credentialProviders.get(provider.id);

          if (!credProvider?.refresh) {
            // No refresh available — passthrough the error
            clientRes.writeHead(statusCode, upRes.headers);
            upRes.pipe(clientRes);
            resolve();
            return;
          }

          // Strategy (a) redirect or (c) passthrough-with-hold
          logger.info(
            { provider: provider.id, scope, status: statusCode, strategy: refreshStrategy },
            'Bearer-swap: auth error, attempting refresh',
          );

          // Drain upstream body (we won't forward it)
          upRes.resume();
          await new Promise<void>((r) => upRes.on('end', r));

          // Await the refresh
          let refreshed = false;
          try {
            refreshed = await credProvider.refresh!(scope, true);
          } catch (err) {
            logger.warn({ err, provider: provider.id }, 'Bearer-swap: refresh threw');
          }

          if (!refreshed || refreshStrategy === 'passthrough') {
            // Strategy (c): forward the original error status
            clientRes.writeHead(statusCode, { 'content-type': 'application/json' });
            clientRes.end(JSON.stringify({ error: 'authentication_error', status: statusCode }));
            resolve();
            return;
          }

          // Strategy (a): 307 redirect to same URL — client re-sends with same
          // substitute token, proxy swaps with refreshed real token
          const redirectUrl = `https://${targetHost}${clientReq.url}`;
          clientRes.writeHead(307, {
            location: redirectUrl,
            'content-length': '0',
          });
          clientRes.end();
          resolve();
        },
      );

      upstream.on('error', (err) => {
        logger.error({ err, host: targetHost, url: clientReq.url }, 'Bearer-swap upstream error');
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end('Bad Gateway');
        }
        resolve();
      });

      // Pipe request body straight through
      clientReq.pipe(upstream);
    });
  };
}

// ---------------------------------------------------------------------------
// Token-exchange handler
// ---------------------------------------------------------------------------

function createTokenExchangeHandler(
  provider: OAuthProvider,
  rule: InterceptRule,
  tokenEngine: TokenSubstituteEngine,
): HostHandler {
  return async (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetHost: string,
    targetPort: number,
    scope: string,
  ): Promise<void> => {
    const scopeAttrs = extractScopeAttrs(targetHost, rule);

    await proxyBuffered(
      clientReq,
      clientRes,
      targetHost,
      targetPort,
      // Header injection: resolve substitute refresh tokens in auth headers
      (_headers) => {},
      // Request transform: swap substitute refresh_token → real
      (body) => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.grant_type === 'refresh_token' && parsed.refresh_token) {
            const entry = tokenEngine.resolveSubstitute(parsed.refresh_token, scope);
            if (entry) {
              return replaceJsonStringValue(body, 'refresh_token', entry.realToken);
            }
          }
        } catch { /* not JSON — check form encoding */ }

        // Form-encoded body
        if (body.includes('grant_type=refresh_token') && body.includes('refresh_token=')) {
          const params = new URLSearchParams(body);
          const subRefresh = params.get('refresh_token');
          if (subRefresh) {
            const entry = tokenEngine.resolveSubstitute(subRefresh, scope);
            if (entry) {
              params.set('refresh_token', entry.realToken);
              return params.toString();
            }
          }
        }

        return body;
      },
      // Response transform: capture real tokens, return substitutes
      (body, _statusCode) => {
        try {
          const tokens = JSON.parse(body);
          if (!tokens.access_token) return body;

          // Generate substitute for access token
          const subAccess = tokenEngine.generateSubstitute(
            tokens.access_token,
            provider.id,
            scopeAttrs,
            scope,
            provider.substituteConfig,
          );

          if (!subAccess) {
            logger.warn(
              { provider: provider.id, scope },
              'Token-exchange: could not generate substitute for access_token',
            );
            return body;
          }

          let result = replaceJsonStringValue(body, 'access_token', subAccess);

          // Generate substitute for refresh token if present
          if (tokens.refresh_token) {
            const subRefresh = tokenEngine.generateSubstitute(
              tokens.refresh_token,
              provider.id,
              scopeAttrs,
              scope,
              provider.substituteConfig,
            );
            if (subRefresh) {
              result = replaceJsonStringValue(result, 'refresh_token', subRefresh);
            }
          }

          return result;
        } catch (err) {
          logger.error({ err, provider: provider.id }, 'Token-exchange: failed to process response');
          return body;
        }
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Authorize-stub handler
// ---------------------------------------------------------------------------

function createAuthorizeStubHandler(
  _provider: OAuthProvider,
  _rule: InterceptRule,
  _tokenEngine: TokenSubstituteEngine,
): HostHandler {
  return async (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetHost: string,
    targetPort: number,
    scope: string,
  ): Promise<void> => {
    // Default: forward the authorize request (passthrough).
    // The container handles the OAuth dance itself.
    // Provider-specific overrides can be registered via credentialProviders.
    const { proxyPipe } = await import('../credential-proxy.js');
    proxyPipe(clientReq, clientRes, targetHost, targetPort, () => {}, scope);
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a HostHandler for a discovery-file provider rule.
 */
export function createHandler(
  provider: OAuthProvider,
  rule: InterceptRule,
  tokenEngine: TokenSubstituteEngine,
  refreshStrategy: RefreshStrategy = 'redirect',
): HostHandler {
  switch (rule.mode) {
    case 'bearer-swap':
      return createBearerSwapHandler(provider, rule, tokenEngine, refreshStrategy);
    case 'token-exchange':
      return createTokenExchangeHandler(provider, rule, tokenEngine);
    case 'authorize-stub':
      return createAuthorizeStubHandler(provider, rule, tokenEngine);
  }
}
