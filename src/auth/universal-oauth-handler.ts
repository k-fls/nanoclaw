/**
 * Universal OAuth handler factory.
 *
 * Creates HostHandler functions for discovery-file providers.
 * Dispatches by InterceptRule.mode:
 *   - bearer-swap: swap Authorization header, send request, check response
 *     status before forwarding. On 401/403: attempt refresh, then apply
 *     strategy — redirect (307), buffer (replay request), or passthrough.
 *   - token-exchange: reuse handleTokenExchange from oauth-interceptor.ts
 *   - authorize-stub: reuse handleAuthorizeStub from oauth-interceptor.ts
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest, RequestOptions } from 'https';

import type { InterceptRule, OAuthProvider, RefreshStrategy } from './oauth-types.js';
import type { GroupScope } from './oauth-types.js';
import type { TokenSubstituteEngine } from './token-substitute.js';
import type { HostHandler } from '../credential-proxy.js';
import { proxyBuffered } from '../credential-proxy.js';
import { replaceJsonStringValue } from '../oauth-interceptor.js';
import type { AuthErrorCallback } from './session-context.js';
import { logger } from '../logger.js';

// Re-export setUpstreamAgent for test use
export { setUpstreamAgent } from '../credential-proxy.js';

// ---------------------------------------------------------------------------
// Auth error callback resolver
// ---------------------------------------------------------------------------

/**
 * Resolves scope → auth error callback. Set once at startup by the proxy.
 * On 401/403 with refresh failure, the bearer-swap handler calls this to
 * get the callback, then invokes it with the buffered upstream body.
 */
type AuthErrorCallbackResolver = (scope: GroupScope) => AuthErrorCallback | null;

let _authErrorResolver: AuthErrorCallbackResolver | null = null;

export function setAuthErrorResolver(resolver: AuthErrorCallbackResolver): void {
  _authErrorResolver = resolver;
}

/**
 * Resolves scope → OAuth initiation callback. Called by authorize-stub handler
 * when the proxy intercepts a request to a known authorization endpoint.
 * The callback pushes to the session's flow queue.
 */
type OAuthInitiationCallback = (authUrl: string, providerId: string, containerIP: string) => void;
type OAuthInitiationResolver = (scope: GroupScope) => OAuthInitiationCallback | null;

let _oauthInitiationResolver: OAuthInitiationResolver | null = null;

export function setOAuthInitiationResolver(resolver: OAuthInitiationResolver): void {
  _oauthInitiationResolver = resolver;
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
// Token refresh via token endpoint (used by bearer-swap on 401)
// ---------------------------------------------------------------------------

/**
 * Find the token endpoint URL from a provider's rules.
 * Returns the full URL (https://host/path) or null if no token-exchange rule.
 */
function findTokenEndpoint(provider: OAuthProvider): string | null {
  const rule = provider.rules.find((r) => r.mode === 'token-exchange');
  if (!rule) return null;
  // Reconstruct URL from anchor + pathPattern source
  const pathSource = rule.pathPattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');  // unescape regex-escaped slashes
  return `https://${rule.anchor}${pathSource}`;
}

/**
 * Attempt to refresh tokens by calling the token endpoint directly.
 * Gets the real refresh token from the resolver, exchanges it, and
 * updates the resolver with new tokens.
 *
 * Returns true if refresh succeeded and the resolver has new tokens.
 */
async function refreshViaTokenEndpoint(
  provider: OAuthProvider,
  tokenEngine: TokenSubstituteEngine,
  groupScope: GroupScope,
): Promise<boolean> {
  const tokenEndpoint = findTokenEndpoint(provider);
  if (!tokenEndpoint) return false;

  // Read refresh token through engine (handles sourceScope indirection internally)
  const realRefreshToken = tokenEngine.resolveRealToken(groupScope, provider.id, 'refresh');
  if (!realRefreshToken) return false;

  try {
    const response = await _tokenFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: realRefreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.warn(
        { provider: provider.id, scope: groupScope, status: response.status },
        'Token refresh: endpoint returned error',
      );
      return false;
    }

    const tokens = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokens.access_token) return false;

    // Write refreshed tokens through engine (handles access check + promote-to-own)
    const expiresTs = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : 0;
    tokenEngine.refreshCredential(groupScope, provider.id, 'access', tokens.access_token, expiresTs);

    if (tokens.refresh_token) {
      tokenEngine.refreshCredential(groupScope, provider.id, 'refresh', tokens.refresh_token);
    }

    logger.info({ provider: provider.id, scope: groupScope }, 'Token refresh succeeded');
    return true;
  } catch (err) {
    logger.warn({ err, provider: provider.id, scope: groupScope }, 'Token refresh failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bearer-swap handler with 401 retry via 307 redirect
// ---------------------------------------------------------------------------

let _upstreamAgent: import('https').Agent | undefined;

/** Set the upstream HTTPS agent (for tests with self-signed certs). */
export function setTestUpstreamAgent(agent: import('https').Agent): void {
  _upstreamAgent = agent;
}

/** Replaceable fetch for token endpoint calls (default: global fetch). */
let _tokenFetch: typeof fetch = globalThis.fetch;

/** Override the fetch used by refreshViaTokenEndpoint (for tests with mock upstreams). */
export function setTokenFetch(fn: typeof fetch): void {
  _tokenFetch = fn;
}

/** Max request body size for buffer strategy before falling back to passthrough. */
const BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Fire the auth error callback (records request_id in pendingErrors).
 * Must be called BEFORE clientRes.end() so the record exists when
 * the container surfaces the error in stdout.
 */
function fireAuthErrorCb(scope: GroupScope, body: string, statusCode: number): void {
  const authErrorCb = _authErrorResolver?.(scope);
  if (authErrorCb) {
    try {
      authErrorCb(body, statusCode);
    } catch (err) {
      logger.error({ err, scope }, 'Auth error callback threw');
    }
  }
}

/**
 * Send an HTTPS request and return the response.
 * Shared by the initial request and the buffer-strategy replay.
 */
function sendUpstream(
  targetHost: string,
  targetPort: number,
  method: string,
  path: string,
  headers: HeaderMap,
  body: Buffer,
): Promise<{ statusCode: number; headers: import('http').IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { hostname: targetHost, port: targetPort, path, method, headers, agent: _upstreamAgent } as RequestOptions,
      async (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        await new Promise<void>((r) => res.on('end', r));
        resolve({ statusCode: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
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
    groupScope,
  ): Promise<void> => {
    const scopeAttrs = extractScopeAttrs(targetHost, rule);
    const headers = prepareHeaders(clientReq, targetHost);

    // Swap Bearer token
    let substitutedToken: string | null = null;
    const authHeader = headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      substitutedToken = authHeader.slice(7);
      const entry = tokenEngine.resolveWithRestriction(substitutedToken, groupScope, scopeAttrs);
      if (entry) {
        headers['authorization'] = `Bearer ${entry.realToken}`;
      }
    }

    // Buffer request body when strategy may need replay (buffer/passthrough).
    // For redirect, pipe straight through (no replay needed).
    let reqBody: Buffer | null = null;
    let effectiveStrategy = refreshStrategy;

    if (refreshStrategy !== 'redirect') {
      const chunks: Buffer[] = [];
      let size = 0;
      await new Promise<void>((resolve) => {
        clientReq.on('data', (c: Buffer) => {
          chunks.push(c);
          size += c.length;
        });
        clientReq.on('end', resolve);
      });
      reqBody = Buffer.concat(chunks);
      // Fall back to passthrough if body exceeds buffer limit
      if (refreshStrategy === 'buffer' && size > BUFFER_MAX_BYTES) {
        effectiveStrategy = 'passthrough';
        logger.debug(
          { provider: provider.id, scope: groupScope, size },
          'Request body exceeds buffer limit, falling back to passthrough',
        );
      }
    }

    // Send request upstream — DON'T pipe response yet, check status first
    await new Promise<void>((resolve) => {
      const upstream = httpsRequest(
        {
          hostname: targetHost,
          port: targetPort,
          path: clientReq.url,
          method: clientReq.method,
          headers: reqBody ? { ...headers, 'content-length': reqBody.length } : headers,
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

          // Auth error — buffer upstream body for correlation, then attempt refresh
          logger.info(
            { provider: provider.id, scope: groupScope, status: statusCode, strategy: effectiveStrategy },
            'Bearer-swap: auth error, attempting refresh',
          );

          const bodyChunks: Buffer[] = [];
          upRes.on('data', (c) => bodyChunks.push(c));
          await new Promise<void>((r) => upRes.on('end', r));
          const upstreamBody = Buffer.concat(bodyChunks).toString();

          const refreshed = await refreshViaTokenEndpoint(provider, tokenEngine, groupScope);

          if (!refreshed) {
            fireAuthErrorCb(groupScope, upstreamBody, statusCode);
            clientRes.writeHead(statusCode, upRes.headers);
            clientRes.end(upstreamBody);
            resolve();
            return;
          }

          // Refresh succeeded — strategy determines what happens next
          switch (effectiveStrategy) {
            case 'redirect': {
              const redirectUrl = `https://${targetHost}${clientReq.url}`;
              clientRes.writeHead(307, { location: redirectUrl, 'content-length': '0' });
              clientRes.end();
              resolve();
              break;
            }

            case 'buffer': {
              // Replay the original request with the refreshed real token
              try {
                const freshEntry = substitutedToken
                  ? tokenEngine.resolveWithRestriction(substitutedToken, groupScope, scopeAttrs)
                  : null;
                const replayHeaders = { ...headers };
                if (freshEntry) {
                  replayHeaders['authorization'] = `Bearer ${freshEntry.realToken}`;
                }
                const replay = await sendUpstream(
                  targetHost, targetPort, clientReq.method || 'GET',
                  clientReq.url || '/', replayHeaders, reqBody!,
                );
                // If replay also fails with auth error, record for the guard
                if (replay.statusCode === 401 || replay.statusCode === 403) {
                  fireAuthErrorCb(groupScope, replay.body.toString(), replay.statusCode);
                }
                const resHeaders = { ...replay.headers, 'content-length': String(replay.body.length) };
                delete resHeaders['transfer-encoding'];
                clientRes.writeHead(replay.statusCode, resHeaders);
                clientRes.end(replay.body);
              } catch (err) {
                logger.error({ err, provider: provider.id }, 'Buffer replay failed');
                if (!clientRes.headersSent) {
                  clientRes.writeHead(502);
                  clientRes.end('Bad Gateway');
                }
              }
              resolve();
              break;
            }

            case 'passthrough': {
              // Forward the original 401 body. Token is already refreshed,
              // so the client's next request will succeed.
              fireAuthErrorCb(groupScope, upstreamBody, statusCode);
              clientRes.writeHead(statusCode, upRes.headers);
              clientRes.end(upstreamBody);
              resolve();
              break;
            }
          }
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

      // Send request body
      if (reqBody) {
        upstream.end(reqBody);
      } else {
        clientReq.pipe(upstream);
      }
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
    groupScope,
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
            const entry = tokenEngine.resolveSubstitute(parsed.refresh_token, groupScope);
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
            const entry = tokenEngine.resolveSubstitute(subRefresh, groupScope);
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
            groupScope,
            provider.substituteConfig,
          );

          if (!subAccess) {
            logger.warn(
              { provider: provider.id, scope: groupScope },
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
              groupScope,
              provider.substituteConfig,
              'refresh',
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
  provider: OAuthProvider,
  _rule: InterceptRule,
  _tokenEngine: TokenSubstituteEngine,
): HostHandler {
  return async (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetHost: string,
    targetPort: number,
    groupScope,
    sourceIP?: string,
  ): Promise<void> => {
    // Reconstruct the full authorization URL
    const authUrl = `https://${targetHost}${clientReq.url}`;

    // Push to flow queue if a session context exists (agent is running)
    const oauthInitCb = _oauthInitiationResolver?.(groupScope);
    if (oauthInitCb) {
      oauthInitCb(authUrl, provider.id, sourceIP || '');

      // Return a stub response — don't forward to upstream.
      // The container's HTTP client gets a 200 with an explanation.
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({
        status: 'intercepted',
        message: 'OAuth authorization URL intercepted by proxy and queued for user authentication',
        url: authUrl,
      }));
      return;
    }

    // No session context — forward the authorize request (passthrough).
    const { proxyPipe } = await import('../credential-proxy.js');
    proxyPipe(clientReq, clientRes, targetHost, targetPort, () => {}, groupScope);
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
