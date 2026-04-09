/**
 * Universal OAuth handler factory.
 *
 * Creates HostHandler functions for discovery-file providers.
 * Dispatches by InterceptRule.mode:
 *   - bearer-swap: swap Authorization header, send request, check response
 *     status before forwarding. On 401/403: attempt refresh, then apply
 *     strategy — redirect (307), buffer (replay request), or passthrough.
 *   - token-exchange: buffer body both ways, swap tokens in JSON/form bodies
 *   - authorize-stub: stub response, push OAuth URL to flow queue
 *   - device-code: forward request, extract user_code, push notification
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest, RequestOptions } from 'https';
import { gunzipSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import type {
  InterceptRule,
  OAuthProvider,
  Credential,
} from './oauth-types.js';
import { CRED_OAUTH, CRED_OAUTH_REFRESH } from './oauth-types.js';
import type { GroupScope } from './oauth-types.js';
import type { TokenSubstituteEngine } from './token-substitute.js';
import type { HostHandler } from './credential-proxy.js';
import { proxyBuffered } from './credential-proxy.js';
import { parseBody } from './oauth-interceptor.js';
import type { AuthErrorCallback } from './session-context.js';
import { writeInterceptStub } from './auth-interactions.js';
import { logger } from '../logger.js';

// Re-export setUpstreamAgent for test use
export { setUpstreamAgent } from './credential-proxy.js';

// ---------------------------------------------------------------------------
// Auth error callback resolver
// ---------------------------------------------------------------------------

/**
 * Resolves scope → auth error callback. Set once at startup by the proxy.
 * On 401/403 with refresh failure, the bearer-swap handler calls this to
 * get the callback, then invokes it with the buffered upstream body.
 */
type AuthErrorCallbackResolver = (
  scope: GroupScope,
) => AuthErrorCallback | null;

let _authErrorResolver: AuthErrorCallbackResolver | null = null;

export function setAuthErrorResolver(
  resolver: AuthErrorCallbackResolver,
): void {
  _authErrorResolver = resolver;
}

/**
 * Resolves scope → OAuth initiation callback. Called by authorize-stub handler
 * when the proxy intercepts a request to a known authorization endpoint.
 * The callback pushes to the session's flow queue.
 */
type OAuthInitiationCallback = (
  authUrl: string,
  providerId: string,
  containerIP: string,
) => string | null;
type OAuthInitiationResolver = (
  scope: GroupScope,
) => OAuthInitiationCallback | null;

let _oauthInitiationResolver: OAuthInitiationResolver | null = null;

export function setOAuthInitiationResolver(
  resolver: OAuthInitiationResolver,
): void {
  _oauthInitiationResolver = resolver;
}

/**
 * Resolves scope → device-code notification callback. Called by device-code
 * handler after forwarding to upstream. Pushes user_code + verification_uri
 * to the session's flow queue as a notification.
 */
type DeviceCodeNotifyCallback = (
  providerId: string,
  userCode: string,
  verificationUri: string,
) => void;
type DeviceCodeNotifyResolver = (
  scope: GroupScope,
) => DeviceCodeNotifyCallback | null;

let _deviceCodeNotifyResolver: DeviceCodeNotifyResolver | null = null;

export function setDeviceCodeNotifyResolver(
  resolver: DeviceCodeNotifyResolver,
): void {
  _deviceCodeNotifyResolver = resolver;
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
    .replace(/\\\//g, '/'); // unescape regex-escaped slashes
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
  const realRefreshToken = tokenEngine.resolveRealToken(
    groupScope,
    provider.id,
    CRED_OAUTH_REFRESH,
  );
  if (!realRefreshToken) return false;

  // Read captured authFields (client_id, scope, etc.) from the oauth credential
  const oauthCred = tokenEngine.resolveCredential(
    groupScope,
    provider.id,
    CRED_OAUTH,
  );
  const authFields = oauthCred?.authFields ?? {};

  try {
    const response = await _tokenFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...authFields,
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

    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokens.access_token) return false;

    // Write refreshed tokens through engine, preserving authFields for future refreshes
    const expiresTs = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : 0;
    tokenEngine.refreshCredential(
      groupScope,
      provider.id,
      CRED_OAUTH,
      tokens.access_token,
      expiresTs,
      authFields,
    );

    if (tokens.refresh_token) {
      tokenEngine.refreshCredential(
        groupScope,
        provider.id,
        CRED_OAUTH_REFRESH,
        tokens.refresh_token,
      );
    }

    logger.info(
      { provider: provider.id, scope: groupScope },
      'Token refresh succeeded',
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, provider: provider.id, scope: groupScope },
      'Token refresh failed',
    );
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
 * How far ahead of actual expiry to trigger proactive refresh (ms).
 * Before sending a request, the proxy checks the access token's expires_ts.
 * If the token expires within this window, it refreshes first — avoiding a
 * 401 round-trip. Set to 0 to disable proactive refresh.
 */
const REFRESH_AHEAD_MS = 60_000; // 60 seconds

/**
 * Fire the auth error callback (records request_id in pendingErrors).
 * Must be called BEFORE clientRes.end() so the record exists when
 * the container surfaces the error in stdout.
 */
function fireAuthErrorCb(
  scope: GroupScope,
  body: string,
  statusCode: number,
): void {
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
): Promise<{
  statusCode: number;
  headers: import('http').IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: targetHost,
        port: targetPort,
        path,
        method,
        headers,
        agent: _upstreamAgent,
      } as RequestOptions,
      async (res) => {
        const chunks: Buffer[] = [];
        res.on('error', (err) => reject(err));
        res.on('data', (c) => chunks.push(c));
        await new Promise<void>((r) => res.on('end', r));
        resolve({
          statusCode: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
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
): HostHandler {
  const refreshStrategy = provider.refreshStrategy;
  return async (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetHost: string,
    targetPort: number,
    groupScope,
  ): Promise<void> => {
    // Capture body chunks immediately — the MITM HTTP parser drains the
    // IncomingMessage at any microtask boundary, so we must attach listeners
    // before doing any work. Chunks queue until a consumer (upstream request
    // or buffer) is connected via pipeTo()/collect().
    const pending: Buffer[] = [];
    let ended = false;
    let sink: ((chunk: Buffer) => void) | null = null;
    let onEnd: (() => void) | null = null;

    clientReq.on('data', (c: Buffer) => {
      pending.push(c);
      sink?.(c);
    });
    clientReq.on('end', () => {
      ended = true;
      onEnd?.();
    });
    /** Pipe queued + future chunks to a writable. Ends it when source ends. */
    function pipeTo(dest: import('http').ClientRequest): void {
      for (const c of pending) dest.write(c);
      if (ended) {
        dest.end();
        return;
      }
      sink = (c) => dest.write(c);
      onEnd = () => dest.end();
    }

    /** Wait for all data and return as a single Buffer. */
    function collect(): Promise<Buffer> {
      if (ended) return Promise.resolve(Buffer.concat(pending));
      return new Promise<Buffer>((res) => {
        onEnd = () => res(Buffer.concat(pending));
      });
    }

    const scopeAttrs = extractScopeAttrs(targetHost, rule);
    const headers = prepareHeaders(clientReq, targetHost);

    // Scan all headers for substitutes, swap real tokens in.
    // Track swaps so the buffer-replay path can re-resolve after refresh.
    const swappedHeaders: Array<{
      headerName: string;
      substitute: string;
      prefix: string; // e.g. "Bearer " — text before the token in the header value
      credentialId: string;
    }> = [];
    let proactiveRefreshAttempted = false;

    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;

      // Extract candidate token: "<scheme> <token>" (Bearer, token, etc.) or bare value
      let candidate: string;
      let prefix: string;
      const spaceIdx = value.indexOf(' ');
      if (spaceIdx > 0 && spaceIdx < 20) {
        prefix = value.slice(0, spaceIdx + 1);
        candidate = value.slice(spaceIdx + 1).trim();
      } else {
        candidate = value.trim();
        prefix = '';
      }

      const entry = tokenEngine.resolveWithRestriction(
        candidate,
        groupScope,
        scopeAttrs,
      );
      // Skip nested sub-tokens (e.g. oauth/refresh) — they should not
      // appear in headers, only in token-exchange request bodies.
      if (!entry || entry.mapping.credentialPath.includes('/')) continue;

      headers[name] = `${prefix}${entry.realToken}`;
      swappedHeaders.push({
        headerName: name,
        substitute: candidate,
        prefix,
        credentialId: entry.mapping.credentialPath,
      });
    }

    // Resolve each swapped credential once. Identify which are refreshable
    // (have a refresh sub-token) and which are near expiry.
    const refreshable = new Set<string>();
    const nearExpiry: string[] = [];
    {
      const seen = new Set<string>();
      for (const swap of swappedHeaders) {
        if (seen.has(swap.credentialId)) continue;
        seen.add(swap.credentialId);
        const cred = tokenEngine.resolveCredential(
          groupScope,
          provider.id,
          swap.credentialId,
        );
        if (!cred?.refresh) continue;
        refreshable.add(swap.credentialId);
        if (
          REFRESH_AHEAD_MS > 0 &&
          cred.expires_ts > 0 &&
          cred.expires_ts < Date.now() + REFRESH_AHEAD_MS
        ) {
          nearExpiry.push(swap.credentialId);
        }
      }
    }

    /** Refresh a set of credentials in parallel. Returns which ones succeeded. */
    const refreshCredentials = async (
      paths: string[],
    ): Promise<{ succeeded: string[]; failed: string[] }> => {
      const results = await Promise.all(
        paths.map((cp) =>
          tokenEngine.sharedOp(groupScope, provider.id, `refresh:${cp}`, () =>
            refreshViaTokenEndpoint(provider, tokenEngine, groupScope),
          ),
        ),
      );
      return {
        succeeded: paths.filter((_, i) => results[i]),
        failed: paths.filter((_, i) => !results[i]),
      };
    };

    /** Re-resolve all swapped headers to pick up fresh real tokens. */
    const reResolveHeaders = () => {
      for (const swap of swappedHeaders) {
        const freshEntry = tokenEngine.resolveWithRestriction(
          swap.substitute,
          groupScope,
          scopeAttrs,
        );
        if (freshEntry) {
          headers[swap.headerName] = `${swap.prefix}${freshEntry.realToken}`;
        }
      }
    };

    // Proactive refresh: for refreshable credentials near expiry,
    // refresh before sending to avoid a 401 round-trip.
    if (nearExpiry.length > 0) {
      proactiveRefreshAttempted = true;
      logger.info(
        { provider: provider.id, scope: groupScope, credentials: nearExpiry },
        'Credentials expired or expiring soon, refreshing before send',
      );

      const { succeeded, failed } = await refreshCredentials(nearExpiry);
      if (succeeded.length > 0) reResolveHeaders();
      if (failed.length > 0) {
        logger.warn(
          { provider: provider.id, scope: groupScope, credentials: failed },
          'Proactive refresh failed for credentials, sending with existing tokens',
        );
      }
    }

    // Buffer strategy: collect full body for potential replay after refresh.
    let reqBody: Buffer | null = null;
    let effectiveStrategy = refreshStrategy;

    if (refreshStrategy === 'buffer') {
      reqBody = await collect();
      if (reqBody.length > BUFFER_MAX_BYTES) {
        effectiveStrategy = 'passthrough';
        logger.debug(
          { provider: provider.id, scope: groupScope, size: reqBody.length },
          'Request body exceeds buffer limit, falling back to passthrough',
        );
      }
    }

    // Send request upstream — DON'T pipe response yet, check status first.
    await new Promise<void>((resolve) => {
      const upstream = httpsRequest(
        {
          hostname: targetHost,
          port: targetPort,
          path: clientReq.url,
          method: clientReq.method,
          headers: reqBody
            ? { ...headers, 'content-length': reqBody.length }
            : headers,
          agent: _upstreamAgent,
        } as RequestOptions,
        async (upRes) => {
          upRes.on('error', () => {
            if (!clientRes.headersSent) {
              clientRes.writeHead(502);
              clientRes.end();
            }
            resolve();
          });
          const statusCode = upRes.statusCode!;

          // Happy path: not an auth error, pipe through
          if (statusCode !== 401) {
            clientRes.writeHead(statusCode, upRes.headers);
            upRes.pipe(clientRes);
            resolve();
            return;
          }

          // Auth error (401 only) — buffer upstream body, then attempt refresh
          const bodyChunks: Buffer[] = [];
          upRes.on('data', (c) => bodyChunks.push(c));
          await new Promise<void>((r) => upRes.on('end', r));
          const upstreamBodyBuf = Buffer.concat(bodyChunks);

          // If proactive refresh already attempted and failed, skip reactive
          // refresh — retrying immediately would be wasteful.
          let refreshed: boolean;
          if (proactiveRefreshAttempted) {
            logger.info(
              {
                provider: provider.id,
                scope: groupScope,
                status: statusCode,
              },
              'Proactive refresh already attempted, skipping reactive refresh',
            );
            refreshed = false;
          } else if (refreshable.size === 0) {
            refreshed = false;
          } else {
            const paths = [...refreshable];
            logger.info(
              {
                provider: provider.id,
                scope: groupScope,
                status: statusCode,
                strategy: effectiveStrategy,
                credentials: paths,
              },
              'Bearer-swap: auth error, attempting refresh',
            );
            const { succeeded } = await refreshCredentials(paths);
            refreshed = succeeded.length > 0;
          }

          // Decode body text for error callbacks (may be gzip-compressed)
          const decodeBody = (
            buf: Buffer,
            headers: typeof upRes.headers,
          ): string => {
            if (headers['content-encoding'] === 'gzip') {
              try {
                return gunzipSync(buf).toString();
              } catch {
                /* fall through */
              }
            }
            return buf.toString();
          };

          // Forward a buffered upstream response with correct content-length.
          // Keep original encoding intact (don't decompress) — just fix the
          // transfer-encoding since we're sending the whole body at once.
          const forwardBuffered = (
            status: number,
            rawHeaders: typeof upRes.headers,
            body: Buffer,
          ) => {
            const h = { ...rawHeaders };
            delete h['transfer-encoding'];
            h['content-length'] = String(body.length);
            clientRes.writeHead(status, h);
            clientRes.end(body);
          };

          if (!refreshed) {
            fireAuthErrorCb(
              groupScope,
              decodeBody(upstreamBodyBuf, upRes.headers),
              statusCode,
            );
            forwardBuffered(statusCode, upRes.headers, upstreamBodyBuf);
            resolve();
            return;
          }

          // Refresh succeeded — strategy determines what happens next
          switch (effectiveStrategy) {
            case 'redirect': {
              const redirectUrl = `https://${targetHost}${clientReq.url}`;
              clientRes.writeHead(307, {
                location: redirectUrl,
                'content-length': '0',
              });
              clientRes.end();
              resolve();
              break;
            }

            case 'buffer': {
              // Replay the original request with refreshed real tokens
              try {
                const replayHeaders = { ...headers };
                for (const swap of swappedHeaders) {
                  const freshEntry = tokenEngine.resolveWithRestriction(
                    swap.substitute,
                    groupScope,
                    scopeAttrs,
                  );
                  if (freshEntry) {
                    replayHeaders[swap.headerName] =
                      `${swap.prefix}${freshEntry.realToken}`;
                  }
                }
                const replay = await sendUpstream(
                  targetHost,
                  targetPort,
                  clientReq.method || 'GET',
                  clientReq.url || '/',
                  replayHeaders,
                  reqBody!,
                );
                // If replay also fails with auth error, record for the guard
                if (replay.statusCode === 401 || replay.statusCode === 403) {
                  fireAuthErrorCb(
                    groupScope,
                    decodeBody(replay.body, replay.headers),
                    replay.statusCode,
                  );
                }
                forwardBuffered(replay.statusCode, replay.headers, replay.body);
              } catch (err) {
                logger.error(
                  { err, provider: provider.id },
                  'Buffer replay failed',
                );
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
              fireAuthErrorCb(
                groupScope,
                decodeBody(upstreamBodyBuf, upRes.headers),
                statusCode,
              );
              forwardBuffered(statusCode, upRes.headers, upstreamBodyBuf);
              resolve();
              break;
            }
          }
        },
      );

      upstream.on('error', (err) => {
        logger.error(
          { err, host: targetHost, url: clientReq.url },
          'Bearer-swap upstream error',
        );
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end('Bad Gateway');
        }
        resolve();
      });

      // Send request body: buffered for buffer strategy, piped for others
      if (reqBody) {
        upstream.end(reqBody);
      } else {
        pipeTo(upstream);
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Token-exchange handler
// ---------------------------------------------------------------------------

/** Fields excluded from auto-capture (transient or contain secrets). */
const TRANSIENT_FIELDS = new Set([
  'grant_type',
  'code',
  'code_verifier',
  'state',
  'redirect_uri',
  'refresh_token',
  'access_token',
  'token_type',
  'expires_in',
]);

/**
 * Build authFields from request + response bodies according to provider config.
 * Auto-capture is the default; explicit fromRequest/fromResponse disables it.
 */
function captureAuthFields(
  reqBody: Record<string, unknown> | null,
  respBody: Record<string, unknown>,
  provider: OAuthProvider,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  const cap = provider.tokenFieldCapture;

  // From request
  if (reqBody) {
    if (cap?.fromRequest) {
      for (const f of cap.fromRequest) {
        const v = reqBody[f];
        if (typeof v === 'string') fields[f] = v;
      }
    } else {
      for (const [k, v] of Object.entries(reqBody)) {
        if (!TRANSIENT_FIELDS.has(k) && typeof v === 'string') fields[k] = v;
      }
    }
  }

  // From response
  if (cap?.fromResponse) {
    for (const f of cap.fromResponse) {
      const v = respBody[f];
      if (typeof v === 'string') fields[f] = v;
    }
  } else {
    if (typeof respBody.scope === 'string') fields['scope'] = respBody.scope;
  }

  // Apply scope modifiers
  if (fields['scope']) {
    let parts = fields['scope'].split(/\s+/);
    if (cap?.scopeExclude) {
      const ex = new Set(cap.scopeExclude);
      parts = parts.filter((s) => !ex.has(s));
    }
    if (cap?.scopeInclude) {
      const inc = new Set(cap.scopeInclude);
      for (const s of inc) {
        if (!parts.includes(s)) parts.push(s);
      }
    }
    fields['scope'] = parts.join(' ');
    if (!fields['scope']) delete fields['scope'];
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

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
    let capturedReqBody: Record<string, unknown> | null = null;

    await proxyBuffered(
      clientReq,
      clientRes,
      targetHost,
      targetPort,
      // Strip accept-encoding (proxyBuffered does toString → corrupts gzip).
      // Don't override Accept — let the client control the response format.
      (headers) => {
        delete headers['accept-encoding'];
      },
      // Request transform: swap substitute refresh_token → real, capture fields
      (body) => {
        const parsed = parseBody(body);
        if (!parsed) return body;
        capturedReqBody = parsed.fields;

        if (
          parsed.fields.grant_type === 'refresh_token' &&
          parsed.fields.refresh_token
        ) {
          const entry = tokenEngine.resolveSubstitute(
            parsed.fields.refresh_token,
            groupScope,
          );
          if (entry) {
            parsed.set('refresh_token', entry.realToken);
            return parsed.serialize();
          }
        }

        return body;
      },
      // Response transform: capture real tokens + authFields, return substitutes.
      // ParsedBody handles both JSON and form-encoded transparently.
      (body, _statusCode) => {
        const parsed = parseBody(body);
        if (!parsed?.fields.access_token) return body;

        try {
          const authFields = captureAuthFields(
            capturedReqBody,
            parsed.fields,
            provider,
          );

          // Store credential in the group's own scope before generating substitutes.
          const credential: Credential = {
            value: parsed.fields.access_token,
            expires_ts: 0,
            updated_ts: Date.now(),
            ...(authFields && { authFields }),
          };
          if (parsed.fields.refresh_token) {
            credential.refresh = {
              value: parsed.fields.refresh_token,
              expires_ts: 0,
              updated_ts: Date.now(),
            };
          }
          tokenEngine.storeGroupCredential(
            groupScope,
            provider.id,
            CRED_OAUTH,
            credential,
          );

          const subAccess = tokenEngine.generateSubstitute(
            parsed.fields.access_token,
            provider.id,
            scopeAttrs,
            groupScope,
            provider.substituteConfig,
            CRED_OAUTH,
          );

          if (!subAccess) {
            logger.warn(
              { provider: provider.id, scope: groupScope },
              'Token-exchange: could not generate substitute for access_token',
            );
            return body;
          }

          parsed.set('access_token', subAccess);

          if (parsed.fields.refresh_token) {
            const subRefresh = tokenEngine.generateSubstitute(
              parsed.fields.refresh_token,
              provider.id,
              scopeAttrs,
              groupScope,
              provider.substituteConfig,
              CRED_OAUTH_REFRESH,
            );
            if (subRefresh) {
              parsed.set('refresh_token', subRefresh);
            }
          }

          return parsed.serialize();
        } catch (err) {
          logger.error(
            { err, provider: provider.id },
            'Token-exchange: failed to process response',
          );
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
      const interactionId = oauthInitCb(authUrl, provider.id, sourceIP || '');
      writeInterceptStub(clientRes, authUrl, interactionId);
      return;
    }

    // No session context — forward the authorize request (passthrough).
    const { proxyPipe } = await import('./credential-proxy.js');
    proxyPipe(
      clientReq,
      clientRes,
      targetHost,
      targetPort,
      () => {},
      groupScope,
    );
  };
}

// ---------------------------------------------------------------------------
// Device-code handler
// ---------------------------------------------------------------------------

/**
 * Forward the device authorization request to upstream, extract user_code
 * and verification_uri from the response, push a notification so the host
 * user can complete the flow, then return the real response to the container.
 */
function createDeviceCodeHandler(
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
  ): Promise<void> => {
    const { proxyBuffered } = await import('./credential-proxy.js');
    await proxyBuffered(
      clientReq,
      clientRes,
      targetHost,
      targetPort,
      (headers) => {
        // Prevent gzip — proxyBuffered does string conversion which corrupts binary
        delete headers['accept-encoding'];
      },
      (body) => body,
      (body, statusCode) => {
        if (statusCode < 200 || statusCode >= 300) return body;
        const parsed = parseBody(body);
        if (parsed) {
          const userCode = parsed.fields.user_code;
          const verificationUri =
            parsed.fields.verification_uri_complete ||
            parsed.fields.verification_uri;
          if (userCode && verificationUri) {
            const cb = _deviceCodeNotifyResolver?.(groupScope);
            cb?.(provider.id, userCode, verificationUri);
          }
        } else {
          logger.warn(
            { provider: provider.id, scope: groupScope },
            'Device-code: could not parse response body',
          );
        }
        return body;
      },
    );
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
): HostHandler {
  switch (rule.mode) {
    case 'bearer-swap':
      return createBearerSwapHandler(provider, rule, tokenEngine);
    case 'token-exchange':
      return createTokenExchangeHandler(provider, rule, tokenEngine);
    case 'authorize-stub':
      return createAuthorizeStubHandler(provider, rule, tokenEngine);
    case 'device-code':
      return createDeviceCodeHandler(provider, rule, tokenEngine);
  }
}
