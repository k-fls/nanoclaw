/**
 * OAuth 2.0 / OpenID Connect interceptor for the MITM proxy.
 *
 * Intercepts OAuth flows transparently so container apps never see real tokens.
 * The host manages real credentials; containers only see substitutes.
 *
 * Interception modes (detected under TLS from full URL):
 *   bearer-swap:     Headers only, body piped through untouched. Hot path.
 *   token-exchange:  Buffer body both directions, swap tokens.
 *   authorize-stub:  Stub response, no upstream call.
 *
 * Detection order:
 *   (a) URL does NOT match tokenEndpoint or authorizeEndpoint → bearer-swap
 *   (b) URL matches tokenEndpoint → token-exchange
 *   (c) URL matches authorizeEndpoint → authorize-stub
 *   (d) Fallback → bearer-swap
 */
import { IncomingMessage, ServerResponse, request as httpRequest, RequestOptions } from 'http';
import { request as httpsRequest } from 'https';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  id_token?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface AuthorizeParams {
  /** Full URL of the authorize request */
  url: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  response_type: string;
  [key: string]: string;
}

export interface StubResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface OAuthCallbacks {
  /** authorize-stub: authorize URL detected. Return stub response for the container. */
  onAuthorize(params: AuthorizeParams): Promise<
    | { action: 'forward' }
    | { action: 'stub'; response: StubResponse }
  >;

  /**
   * token-exchange: real tokens received from token endpoint (exchange or refresh).
   * Store real tokens, return substitutes for the container.
   */
  onTokens(real: TokenSet): Promise<TokenSet>;

  /**
   * token-exchange outbound: map substitute refresh token → real refresh token.
   * Called before forwarding refresh request to upstream.
   */
  resolveRefreshToken(substitute: string): Promise<string>;

  /**
   * bearer-swap: map substitute access token → real access token.
   * Called on every API request with Authorization: Bearer header.
   * Return null if token is unknown (pass through unmodified).
   */
  resolveAccessToken(substitute: string): Promise<string | null>;
}

export interface OAuthProviderConfig {
  /** Identifier for logging */
  id: string;

  /** Regex matched against "host/path" to detect token endpoint (token-exchange) */
  tokenEndpoint: RegExp;

  /** Regex matched against "host/path" to detect authorize endpoint (authorize-stub) */
  authorizeEndpoint: RegExp;

  /** Regex matched against "host/path" for Bearer token swap (bearer-swap) */
  protectedUrls: RegExp;

  callbacks: OAuthCallbacks;
}

export type RequestMode =
  | { mode: 'bearer-swap'; provider: OAuthProviderConfig }
  | { mode: 'token-exchange'; provider: OAuthProviderConfig }
  | { mode: 'authorize-stub'; provider: OAuthProviderConfig }
  | null;

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

/**
 * Determine the interception mode for a request.
 * Input: host (from CONNECT) + path (from HTTP request line after TLS).
 */
export function detectMode(
  host: string,
  urlPath: string,
  providers: OAuthProviderConfig[],
): RequestMode {
  const fullUrl = host + urlPath;

  for (const provider of providers) {
    // Check specific endpoints first
    if (provider.tokenEndpoint.test(fullUrl)) {
      return { mode: 'token-exchange', provider };
    }
    if (provider.authorizeEndpoint.test(fullUrl)) {
      return { mode: 'authorize-stub', provider };
    }
    // Then broad API match
    if (provider.protectedUrls.test(fullUrl)) {
      return { mode: 'bearer-swap', provider };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Form body helpers — preserve field order
// ---------------------------------------------------------------------------

/** Parse application/x-www-form-urlencoded preserving field order. */
function parseForm(body: string): Array<[string, string]> {
  if (!body) return [];
  return body.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return [decodeURIComponent(pair), ''] as [string, string];
    return [
      decodeURIComponent(pair.slice(0, eq)),
      decodeURIComponent(pair.slice(eq + 1)),
    ] as [string, string];
  });
}

/** Serialize form fields preserving order. */
function serializeForm(fields: Array<[string, string]>): string {
  return fields
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Get a field value from ordered form fields. */
function getField(fields: Array<[string, string]>, name: string): string | undefined {
  const entry = fields.find(([k]) => k === name);
  return entry?.[1];
}

/** Replace a field value in-place, preserving position. */
function setField(fields: Array<[string, string]>, name: string, value: string): void {
  const entry = fields.find(([k]) => k === name);
  if (entry) {
    entry[1] = value;
  }
}

// ---------------------------------------------------------------------------
// JSON body helpers — preserve field order via string manipulation
// ---------------------------------------------------------------------------

/**
 * Replace a string value for a given key in a JSON string, preserving
 * all other content byte-for-byte (field order, whitespace, other fields).
 *
 * Only handles simple string values — not nested objects, arrays, or numbers.
 * Sufficient for OAuth token fields (access_token, refresh_token, etc).
 */
export function replaceJsonStringValue(
  json: string,
  key: string,
  newValue: string,
): string {
  // Match "key" : "value" with flexible whitespace
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `("${escaped}"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`,
  );
  const match = re.exec(json);
  if (!match) return json;
  // Escape the new value for JSON string context
  const jsonEscaped = newValue
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return (
    json.slice(0, match.index) +
    match[1] +
    '"' +
    jsonEscaped +
    '"' +
    json.slice(match.index + match[0].length)
  );
}

/**
 * Extract a string value for a given key from a JSON string.
 * Does not parse the full JSON — uses regex for speed.
 */
function extractJsonStringValue(json: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"${escaped}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = re.exec(json);
  if (!match) return undefined;
  // Unescape JSON string
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

// ---------------------------------------------------------------------------
// Shared header utilities
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
// bearer-swap: swap Authorization header, pipe body untouched
// ---------------------------------------------------------------------------

export async function handleBearerSwap(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  targetPort: number,
  provider: OAuthProviderConfig,
  useTls: boolean,
  rejectUnauthorized: boolean,
): Promise<void> {
  const headers = prepareHeaders(req, targetHost);

  // Swap Bearer token in Authorization header
  const authHeader = headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const substitute = authHeader.slice(7);
    const real = await provider.callbacks.resolveAccessToken(substitute);
    if (real) {
      headers['authorization'] = `Bearer ${real}`;
    }
  }

  const makeReq = useTls ? httpsRequest : httpRequest;
  const upstream = makeReq(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
      rejectUnauthorized,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error({ err, host: targetHost, url: req.url }, 'OAuth bearer-swap upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  // Pipe request body straight through — no buffering
  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// token-exchange: buffer body both directions, swap tokens
// ---------------------------------------------------------------------------

export async function handleTokenExchange(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  targetPort: number,
  provider: OAuthProviderConfig,
  useTls: boolean,
  rejectUnauthorized: boolean,
): Promise<void> {
  // Buffer the request body
  const reqChunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (c) => reqChunks.push(c));
    req.on('end', resolve);
  });
  let reqBody = Buffer.concat(reqChunks).toString();

  // Parse form body to detect grant_type and swap refresh token if needed
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const isForm = contentType.includes('application/x-www-form-urlencoded');

  if (isForm) {
    const fields = parseForm(reqBody);
    const grantType = getField(fields, 'grant_type');

    if (grantType === 'refresh_token') {
      const substituteRefresh = getField(fields, 'refresh_token');
      if (substituteRefresh) {
        const realRefresh = await provider.callbacks.resolveRefreshToken(substituteRefresh);
        setField(fields, 'refresh_token', realRefresh);
        reqBody = serializeForm(fields);
      }
    }
    // For authorization_code grant, pass body through untouched
    // (code, client_id, client_secret, redirect_uri, code_verifier all stay as-is)
  }

  const reqBodyBuf = Buffer.from(reqBody);
  const headers = prepareHeaders(req, targetHost, reqBodyBuf.length);

  // Forward to upstream and buffer response
  const makeReq = useTls ? httpsRequest : httpRequest;

  await new Promise<void>((resolve) => {
    const upstream = makeReq(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers,
        rejectUnauthorized,
      } as RequestOptions,
      async (upRes) => {
        // Buffer response body
        const resChunks: Buffer[] = [];
        await new Promise<void>((r) => {
          upRes.on('data', (c: Buffer) => resChunks.push(c));
          upRes.on('end', r);
        });
        let resBody = Buffer.concat(resChunks).toString();

        // Only process successful token responses
        if (upRes.statusCode === 200) {
          try {
            // Extract real tokens from response — parse minimally
            const accessToken = extractJsonStringValue(resBody, 'access_token');

            if (accessToken) {
              // Build a TokenSet for the callback by parsing the full JSON
              // (response bodies are small, <1KB)
              const realTokens: TokenSet = JSON.parse(resBody);

              // Callback stores real tokens, returns substitutes
              const substitutes = await provider.callbacks.onTokens(realTokens);

              // Replace token values in response body preserving field order
              resBody = replaceJsonStringValue(
                resBody,
                'access_token',
                substitutes.access_token,
              );
              if (substitutes.refresh_token) {
                resBody = replaceJsonStringValue(
                  resBody,
                  'refresh_token',
                  substitutes.refresh_token,
                );
              }
            }
          } catch (err) {
            logger.error(
              { err, host: targetHost, url: req.url },
              'OAuth token-exchange token processing error',
            );
            // On error, pass through unmodified — don't break the flow
          }
        }

        // Send response to client with correct content-length
        const resBodyBuf = Buffer.from(resBody);
        const resHeaders = { ...upRes.headers };
        resHeaders['content-length'] = String(resBodyBuf.length);
        // Remove chunked encoding since we're sending a complete body
        delete resHeaders['transfer-encoding'];

        res.writeHead(upRes.statusCode!, resHeaders);
        res.end(resBodyBuf);
        resolve();
      },
    );

    upstream.on('error', (err) => {
      logger.error({ err, host: targetHost, url: req.url }, 'OAuth token-exchange upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
      resolve();
    });

    upstream.write(reqBodyBuf);
    upstream.end();
  });
}

// ---------------------------------------------------------------------------
// authorize-stub: return synthetic response, no upstream call
// ---------------------------------------------------------------------------

export async function handleAuthorizeStub(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  provider: OAuthProviderConfig,
): Promise<'stub' | 'forward'> {
  // Parse authorize params from query string
  const urlObj = new URL(req.url || '/', `https://${targetHost}`);
  const params: AuthorizeParams = {
    url: `https://${targetHost}${req.url}`,
    client_id: urlObj.searchParams.get('client_id') || '',
    redirect_uri: urlObj.searchParams.get('redirect_uri') || '',
    scope: urlObj.searchParams.get('scope') || '',
    state: urlObj.searchParams.get('state') || '',
    response_type: urlObj.searchParams.get('response_type') || '',
  };
  // Capture all query params
  for (const [k, v] of urlObj.searchParams.entries()) {
    if (!(k in params)) {
      params[k] = v;
    }
  }

  const result = await provider.callbacks.onAuthorize(params);

  if (result.action === 'stub') {
    const { statusCode, headers, body } = result.response;
    res.writeHead(statusCode, {
      ...headers,
      'content-length': String(Buffer.byteLength(body)),
    });
    res.end(body);
    return 'stub';
  }

  // 'forward' — let caller handle it as mode 2 (no cred injection, just pass through)
  return 'forward';
}
