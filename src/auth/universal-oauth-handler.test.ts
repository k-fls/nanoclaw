import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import https from 'https';
import http from 'http';
import { Agent } from 'https';

import {
  createHandler,
  setTestUpstreamAgent,
  setAuthErrorResolver,
  setOAuthInitiationResolver,
  setTokenFetch,
} from './universal-oauth-handler.js';
import { setUpstreamAgent } from '../credential-proxy.js';
import {
  TokenSubstituteEngine,
  PersistentTokenResolver,
} from './token-substitute.js';
import type { OAuthProvider, InterceptRule } from './oauth-types.js';
import {
  DEFAULT_SUBSTITUTE_CONFIG,
  asGroupScope,
  asCredentialScope,
} from './oauth-types.js';
import { muteLogger, restoreLogger } from '../test-helpers.js';
import { initCredentialStore } from './store.js';

// ---------------------------------------------------------------------------
// Self-signed HTTPS test server
// ---------------------------------------------------------------------------

// Generate self-signed cert inline for tests
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testServer: https.Server;
let serverPort: number;
let tmpDir: string;
let logSpies: ReturnType<typeof muteLogger>;

// Track requests the test server receives
let lastRequest: {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
} | null = null;
let serverResponseOverride: {
  status: number;
  body: string;
  headers?: Record<string, string>;
} | null = null;

beforeAll(async () => {
  logSpies = muteLogger();
  // Generate self-signed cert
  tmpDir = mkdtempSync(join(tmpdir(), 'oauth-handler-test-'));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${tmpDir}/key.pem -out ${tmpDir}/cert.pem -days 1 -nodes -subj "/CN=localhost"`,
    { stdio: 'pipe' },
  );

  const key = readFileSync(join(tmpDir, 'key.pem'));
  const cert = readFileSync(join(tmpDir, 'cert.pem'));

  testServer = https.createServer({ key, cert }, async (req, res) => {
    // Buffer request body
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', resolve);
    });

    lastRequest = {
      method: req.method || '',
      url: req.url || '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };

    if (serverResponseOverride) {
      const { status, body, headers: h } = serverResponseOverride;
      res.writeHead(status, { 'content-type': 'application/json', ...h });
      res.end(body);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  });

  await new Promise<void>((resolve) => {
    testServer.listen(0, '127.0.0.1', () => {
      const addr = testServer.address() as import('net').AddressInfo;
      serverPort = addr.port;
      resolve();
    });
  });

  // Use an agent that trusts our self-signed cert (both the bearer-swap local agent
  // and the proxyBuffered module-level agent)
  const agent = new Agent({ rejectUnauthorized: false });
  setTestUpstreamAgent(agent);
  setUpstreamAgent(agent);
});

afterAll(() => {
  restoreLogger(logSpies);
  testServer.close();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {
    /* ok */
  }
});

beforeEach(() => {
  lastRequest = null;
  serverResponseOverride = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(id = 'test-provider'): OAuthProvider {
  return {
    id,
    rules: [],
    scopeKeys: [],
    substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
    refreshStrategy: 'redirect',
  };
}

function makeBearerSwapRule(anchor = 'localhost'): InterceptRule {
  return {
    anchor,
    pathPattern: /^\//,
    mode: 'bearer-swap',
  };
}

function makeTokenExchangeRule(anchor = 'localhost'): InterceptRule {
  return {
    anchor,
    pathPattern: /^\/oauth\/token$/,
    mode: 'token-exchange',
  };
}

function makeAuthorizeStubRule(anchor = 'localhost'): InterceptRule {
  return {
    anchor,
    pathPattern: /^\/oauth\/authorize/,
    mode: 'authorize-stub',
  };
}

/** Create a mock HTTP request/response pair for handler testing. */
function mockRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body = '',
): {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  getResponse: () => Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;
} {
  // Use a real HTTP server to create proper IncomingMessage/ServerResponse
  return null as any; // Placeholder — we'll use a different approach
}

/**
 * Execute a handler by running a local HTTP server that calls it,
 * then making a request to that server.
 */
async function executeHandler(
  handler: ReturnType<typeof createHandler>,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    targetHost?: string;
    targetPort?: number;
    scope?: import('./oauth-types.js').GroupScope;
  } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const {
    method = 'GET',
    path = '/api/test',
    headers = {},
    body = '',
    targetHost = '127.0.0.1',
    targetPort = serverPort,
    scope = asGroupScope('test-scope'),
  } = opts;

  // Create a temporary HTTP server that feeds into the handler
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res, targetHost, targetPort, scope);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Handler error');
      }
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('net').AddressInfo;
      resolve(addr.port);
    });
  });

  try {
    return await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: { ...headers, host: targetHost },
        },
        async (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('universal-oauth-handler', () => {
  describe('bearer-swap', () => {
    it('swaps substitute Bearer token with real token', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      // Register a token
      const realToken = 'real_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const sub = engine.generateSubstitute(
        realToken,
        'test-provider',
        {},
        asGroupScope('test-scope'),
        DEFAULT_SUBSTITUTE_CONFIG,
      )!;
      expect(sub).not.toBeNull();

      const res = await executeHandler(handler, {
        headers: { authorization: `Bearer ${sub}` },
      });

      expect(res.status).toBe(200);
      // Upstream should have received the real token
      expect(lastRequest).not.toBeNull();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${realToken}`);
    });

    it('passes through unknown tokens (no substitution)', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      const res = await executeHandler(handler, {
        headers: { authorization: 'Bearer unknown-token' },
      });

      expect(res.status).toBe(200);
      expect(lastRequest!.headers['authorization']).toBe(
        'Bearer unknown-token',
      );
    });

    it('pipes through requests without Authorization header', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      const res = await executeHandler(handler);
      expect(res.status).toBe(200);
    });

    it('does not resolve refresh token substitutes in headers', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      // Generate a refresh token substitute
      const realRefresh =
        'refresh_abcdefghijklmnopqrstuvwxyz1234567890abcdefgh';
      const subRefresh = engine.generateSubstitute(
        realRefresh,
        'test-provider',
        {},
        asGroupScope('test-scope'),
        DEFAULT_SUBSTITUTE_CONFIG,
        'refresh',
      )!;
      expect(subRefresh).not.toBeNull();

      const res = await executeHandler(handler, {
        headers: { authorization: `Bearer ${subRefresh}` },
      });

      expect(res.status).toBe(200);
      // Refresh substitute must NOT be resolved — should pass through as-is
      expect(lastRequest!.headers['authorization']).toBe(
        `Bearer ${subRefresh}`,
      );
    });

    it('resolves bare header substitutes (x-api-key style)', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      const realKey = 'key_xabcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';
      const subKey = engine.generateSubstitute(
        realKey,
        'test-provider',
        {},
        asGroupScope('test-scope'),
        DEFAULT_SUBSTITUTE_CONFIG,
        'api_key',
      )!;
      expect(subKey).not.toBeNull();

      const res = await executeHandler(handler, {
        headers: { 'x-api-key': subKey },
      });

      expect(res.status).toBe(200);
      expect(lastRequest!.headers['x-api-key']).toBe(realKey);
    });

    it('resolves "token" prefix (gh CLI style: Authorization: token gho_...)', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      const realToken = 'gho_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';
      const sub = engine.generateSubstitute(
        realToken,
        'test-provider',
        {},
        asGroupScope('test-scope'),
        DEFAULT_SUBSTITUTE_CONFIG,
      )!;
      expect(sub).not.toBeNull();

      const res = await executeHandler(handler, {
        headers: { authorization: `token ${sub}` },
      });

      expect(res.status).toBe(200);
      // Upstream should have "token <real>" — prefix preserved
      expect(lastRequest!.headers['authorization']).toBe(`token ${realToken}`);
    });

    it('returns 307 redirect on 401 when refresh succeeds', async () => {
      const resolver = new PersistentTokenResolver();
      const engine = new TokenSubstituteEngine(resolver);

      // Provider with a token-exchange rule pointing to the test server
      // Uses port in anchor so refreshViaTokenEndpoint can reach it
      const provider: OAuthProvider = {
        id: 'refreshable',
        rules: [
          {
            anchor: `127.0.0.1:${serverPort}`,
            pathPattern: /^\/oauth\/token$/,
            mode: 'token-exchange',
          },
        ],
        scopeKeys: [],
        substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
        refreshStrategy: 'redirect',
      };

      // Store a refresh token in the resolver so the refresh can find it
      resolver.store(
        'real_refresh_token_value',
        'refreshable',
        asCredentialScope('test-scope'),
        'refresh',
      );
      // Store an access token too
      resolver.store(
        'real_access_token_value',
        'refreshable',
        asCredentialScope('test-scope'),
        'access',
      );

      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      // First request (API call) returns 401, triggering refresh.
      // The refresh call to /oauth/token should get 200 with new tokens
      // (default test server response). Set up so the API call returns 401.
      let callCount = 0;
      serverResponseOverride = null;
      // Override the test server to return 401 for API calls, 200 with tokens for /oauth/token
      const origHandler = testServer.listeners('request')[0] as Function;
      testServer.removeAllListeners('request');
      testServer.on(
        'request',
        (req: http.IncomingMessage, res: http.ServerResponse) => {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            lastRequest = {
              method: req.method || '',
              url: req.url || '',
              headers: req.headers,
              body: Buffer.concat(chunks).toString(),
            };
            if (req.url === '/oauth/token') {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  access_token: 'new_access',
                  refresh_token: 'new_refresh',
                }),
              );
            } else {
              res.writeHead(401, { 'content-type': 'application/json' });
              res.end('{"error":"unauthorized"}');
            }
          });
        },
      );

      const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      try {
        const res = await executeHandler(handler, { path: '/api/test' });
        expect(res.status).toBe(307);
        expect(res.headers['location']).toBe('https://127.0.0.1/api/test');
      } finally {
        // Restore original handler and TLS setting
        testServer.removeAllListeners('request');
        testServer.on('request', origHandler as any);
        if (origTls === undefined)
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
      }
    });

    it('passes through 401 when no refresh token available', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider('no-refresh');
      const rule = makeBearerSwapRule();
      const handler = createHandler(provider, rule, engine);

      serverResponseOverride = {
        status: 401,
        body: '{"error":"unauthorized"}',
      };

      const res = await executeHandler(handler);
      expect(res.status).toBe(401);
    });

    it('blocks cross-tenant token injection via scope attrs', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();

      // Two rules for different tenants on the same provider
      const acmeRule: InterceptRule = {
        anchor: 'zendesk.com',
        hostPattern: /^(?<subdomain>[^.]+)\.zendesk\.com$/,
        pathPattern: /^\//,
        mode: 'bearer-swap',
      };

      // Token scoped to tenant "acme"
      const realToken = 'real_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const sub = engine.generateSubstitute(
        realToken,
        'test-provider',
        { subdomain: 'acme' },
        asGroupScope('test-scope'),
        DEFAULT_SUBSTITUTE_CONFIG,
      )!;

      // Handler for evil.zendesk.com — same rule pattern, different actual host
      const handler = createHandler(provider, acmeRule, engine);

      // Request goes to localhost (our test server) but handler evaluates
      // scope attrs against targetHost "evil.zendesk.com"
      // The test server is at 127.0.0.1 but we override targetHost for scope extraction
      const res = await executeHandler(handler, {
        targetHost: '127.0.0.1',
        targetPort: serverPort,
        headers: { authorization: `Bearer ${sub}` },
      });

      // The hostPattern won't match "127.0.0.1" so scopeAttrs will be empty,
      // which means resolveWithRestriction allows it (empty requiredAttrs = no restriction).
      // To properly test cross-tenant: we need the engine's resolveWithRestriction
      // called with mismatched attrs. Test the engine directly instead:
      const blocked = engine.resolveWithRestriction(
        sub,
        asGroupScope('test-scope'),
        { subdomain: 'evil' },
      );
      expect(blocked).toBeNull();

      const allowed = engine.resolveWithRestriction(
        sub,
        asGroupScope('test-scope'),
        { subdomain: 'acme' },
      );
      expect(allowed).not.toBeNull();
      expect(allowed!.realToken).toBe(realToken);
    });

    it('proactive strategy refreshes before send when token is near expiry', async () => {
      initCredentialStore();
      const spies = muteLogger();
      try {
        const resolver = new PersistentTokenResolver();
        const engine = new TokenSubstituteEngine(resolver);

        const provider: OAuthProvider = {
          id: 'proactive-test',
          rules: [
            {
              anchor: `127.0.0.1:${serverPort}`,
              pathPattern: /^\/oauth\/token$/,
              mode: 'token-exchange',
            },
          ],
          scopeKeys: [],
          substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
          refreshStrategy: 'proactive',
        };

        // Generate a substitute first (stores with expires_ts=0 internally)
        const realAccess =
          'old_access_abcdefghijklmnopqrstuvwxyz1234567890abcde';
        const sub = engine.generateSubstitute(
          realAccess,
          'proactive-test',
          {},
          asGroupScope('test-scope'),
          DEFAULT_SUBSTITUTE_CONFIG,
        )!;
        expect(sub).not.toBeNull();

        // Now set the expiry to near-future (within 60s REFRESH_AHEAD_MS window)
        resolver.store(
          realAccess,
          'proactive-test',
          asCredentialScope('test-scope'),
          'access',
          Date.now() + 10_000, // 10s from now
        );
        resolver.store(
          'real_refresh_token_value',
          'proactive-test',
          asCredentialScope('test-scope'),
          'refresh',
        );

        const rule = makeBearerSwapRule();
        const handler = createHandler(provider, rule, engine);

        // Mock the token fetch so refresh succeeds
        const newAccess =
          'new_access_abcdefghijklmnopqrstuvwxyz1234567890abcde';
        setTokenFetch(
          async () =>
            new Response(
              JSON.stringify({
                access_token: newAccess,
                refresh_token: 'new_refresh_value',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
        );

        try {
          const res = await executeHandler(handler, {
            headers: { authorization: `Bearer ${sub}` },
          });

          // Request should succeed — upstream sees the NEW token, not the old one
          expect(res.status).toBe(200);
          expect(lastRequest).not.toBeNull();
          expect(lastRequest!.headers['authorization']).toBe(
            `Bearer ${newAccess}`,
          );
        } finally {
          setTokenFetch(globalThis.fetch);
        }
      } finally {
        restoreLogger(spies);
      }
    });

    it('proactive strategy skips reactive refresh on 401 after proactive attempt', async () => {
      initCredentialStore();
      const spies = muteLogger();
      try {
        const resolver = new PersistentTokenResolver();
        const engine = new TokenSubstituteEngine(resolver);

        const provider: OAuthProvider = {
          id: 'proactive-fail',
          rules: [
            {
              anchor: `127.0.0.1:${serverPort}`,
              pathPattern: /^\/oauth\/token$/,
              mode: 'token-exchange',
            },
          ],
          scopeKeys: [],
          substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
          refreshStrategy: 'proactive',
        };

        // Generate substitute first, then set expired expiry
        const realAccess =
          'expired_access_abcdefghijklmnopqrstuvwxyz12345678ab';
        const sub = engine.generateSubstitute(
          realAccess,
          'proactive-fail',
          {},
          asGroupScope('test-scope'),
          DEFAULT_SUBSTITUTE_CONFIG,
        )!;

        // Set access token as already expired
        resolver.store(
          realAccess,
          'proactive-fail',
          asCredentialScope('test-scope'),
          'access',
          Date.now() - 5_000, // 5s ago — expired
        );
        resolver.store(
          'real_refresh_token_value',
          'proactive-fail',
          asCredentialScope('test-scope'),
          'refresh',
        );

        const rule = makeBearerSwapRule();
        const handler = createHandler(provider, rule, engine);

        // Mock refresh to fail
        setTokenFetch(async () => new Response('{}', { status: 400 }));

        // Track auth error callbacks
        let authErrorCalled = false;
        setAuthErrorResolver(() => () => {
          authErrorCalled = true;
        });

        // Upstream returns 401
        serverResponseOverride = {
          status: 401,
          body: '{"error":"unauthorized"}',
        };

        try {
          const res = await executeHandler(handler, {
            headers: { authorization: `Bearer ${sub}` },
          });

          // Should get 401 forwarded (no redirect, no retry)
          expect(res.status).toBe(401);
          expect(authErrorCalled).toBe(true);
        } finally {
          setTokenFetch(globalThis.fetch);
          setAuthErrorResolver(() => null);
          serverResponseOverride = null;
        }
      } finally {
        restoreLogger(spies);
      }
    });

    it('proactive strategy forwards 401 without reactive refresh when token is not near expiry', async () => {
      initCredentialStore();
      const spies = muteLogger();
      try {
        const resolver = new PersistentTokenResolver();
        const engine = new TokenSubstituteEngine(resolver);

        const provider: OAuthProvider = {
          id: 'proactive-noretry',
          rules: [
            {
              anchor: `127.0.0.1:${serverPort}`,
              pathPattern: /^\/oauth\/token$/,
              mode: 'token-exchange',
            },
          ],
          scopeKeys: [],
          substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
          refreshStrategy: 'proactive',
        };

        const realAccess =
          'valid_access_abcdefghijklmnopqrstuvwxyz1234567890abcd';
        const sub = engine.generateSubstitute(
          realAccess,
          'proactive-noretry',
          {},
          asGroupScope('test-scope'),
          DEFAULT_SUBSTITUTE_CONFIG,
        )!;

        // Access token valid for another hour — no proactive refresh triggered
        resolver.store(
          realAccess,
          'proactive-noretry',
          asCredentialScope('test-scope'),
          'access',
          Date.now() + 3_600_000,
        );
        resolver.store(
          'real_refresh_token_value',
          'proactive-noretry',
          asCredentialScope('test-scope'),
          'refresh',
        );

        const rule = makeBearerSwapRule();
        const handler = createHandler(provider, rule, engine);

        // Track auth error callbacks
        let authErrorCalled = false;
        setAuthErrorResolver(() => () => {
          authErrorCalled = true;
        });

        // Upstream returns 401 (e.g. server-side revocation)
        serverResponseOverride = {
          status: 401,
          body: '{"error":"unauthorized"}',
        };

        try {
          const res = await executeHandler(handler, {
            headers: { authorization: `Bearer ${sub}` },
          });

          // Proactive strategy never does reactive refresh — just forwards 401
          expect(res.status).toBe(401);
          expect(authErrorCalled).toBe(true);
        } finally {
          setAuthErrorResolver(() => null);
          serverResponseOverride = null;
        }
      } finally {
        restoreLogger(spies);
      }
    });
  });

  it('buffer strategy calls authErrorCb when replay also returns 401', async () => {
    const resolver = new PersistentTokenResolver();
    const engine = new TokenSubstituteEngine(resolver);

    const provider: OAuthProvider = {
      id: 'buf-replay',
      rules: [
        {
          anchor: `127.0.0.1:${serverPort}`,
          pathPattern: /^\/oauth\/token$/,
          mode: 'token-exchange',
        },
      ],
      scopeKeys: [],
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      refreshStrategy: 'buffer',
    };

    resolver.store(
      'real_refresh_value',
      'buf-replay',
      asCredentialScope('test-scope'),
      'refresh',
    );
    resolver.store(
      'real_access_value',
      'buf-replay',
      asCredentialScope('test-scope'),
      'access',
    );

    const rule = makeBearerSwapRule();
    const handler = createHandler(provider, rule, engine);

    // Track auth error callbacks
    let authErrorCalled = false;
    setAuthErrorResolver(() => () => {
      authErrorCalled = true;
    });

    // Server: /oauth/token returns new tokens, everything else returns 401
    // (even after refresh — simulates immediate revocation)
    const origHandler = testServer.listeners('request')[0] as Function;
    testServer.removeAllListeners('request');
    testServer.on(
      'request',
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          lastRequest = {
            method: req.method || '',
            url: req.url || '',
            headers: req.headers,
            body: Buffer.concat(chunks).toString(),
          };
          if (req.url === '/oauth/token') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                access_token: 'new_access',
                refresh_token: 'new_refresh',
              }),
            );
          } else {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'unauthorized',
                request_id: 'req_replay',
              }),
            );
          }
        });
      },
    );

    const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await executeHandler(handler, {
        path: '/api/test',
        body: 'small-body',
        method: 'POST',
      });
      // Replay 401 forwarded to container
      expect(res.status).toBe(401);
      // Auth error callback must have fired for the replay 401
      expect(authErrorCalled).toBe(true);
    } finally {
      testServer.removeAllListeners('request');
      testServer.on('request', origHandler as any);
      setAuthErrorResolver(() => null);
      if (origTls === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    }
  });

  describe('token-exchange', () => {
    it('generates substitute tokens from upstream response', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeTokenExchangeRule();
      const handler = createHandler(provider, rule, engine);

      // Upstream returns real tokens
      serverResponseOverride = {
        status: 200,
        body: JSON.stringify({
          access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
          refresh_token: 'real_refresh_abcdefghijklmnopqrstuvwxyz1234567890a',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };

      const res = await executeHandler(handler, {
        method: 'POST',
        path: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=abc123',
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);

      // Response should contain substitutes, not real tokens
      expect(body.access_token).not.toBe(
        'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
      );
      expect(body.access_token.startsWith('real_acces')).toBe(true); // prefix preserved
      expect(body.refresh_token).not.toBe(
        'real_refresh_abcdefghijklmnopqrstuvwxyz1234567890a',
      );

      // Engine should have the mapping
      expect(engine.size).toBe(2); // access + refresh
    });

    it('resolves substitute refresh token on refresh grant', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider();
      const rule = makeTokenExchangeRule();
      const handler = createHandler(provider, rule, engine);

      // Pre-register a refresh token substitute
      const realRefresh = 'real_refresh_abcdefghijklmnopqrstuvwxyz1234567890a';
      const subRefresh = engine.generateSubstitute(
        realRefresh,
        'test-provider',
        {},
        asGroupScope('test-scope'),
        DEFAULT_SUBSTITUTE_CONFIG,
      )!;

      // Upstream returns new tokens
      serverResponseOverride = {
        status: 200,
        body: JSON.stringify({
          access_token: 'new_access_abcdefghijklmnopqrstuvwxyz1234567890abc',
          refresh_token: 'new_refresh_abcdefghijklmnopqrstuvwxyz1234567890ab',
          token_type: 'Bearer',
        }),
      };

      const res = await executeHandler(handler, {
        method: 'POST',
        path: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(subRefresh)}`,
      });

      expect(res.status).toBe(200);

      // Upstream should have received the real refresh token
      expect(lastRequest!.body).toContain(encodeURIComponent(realRefresh));
    });

    // -----------------------------------------------------------------------
    // Token field capture
    // -----------------------------------------------------------------------

    it('auto-captures client_id from request and scope from response', async () => {
      const spies = muteLogger();
      try {
        const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
        const provider = makeProvider();
        const rule = makeTokenExchangeRule();
        const handler = createHandler(provider, rule, engine);

        serverResponseOverride = {
          status: 200,
          body: JSON.stringify({
            access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
            refresh_token: 'real_refresh_abcdefghijklmnopqrstuvwxyz1234567890a',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read write',
          }),
        };

        const res = await executeHandler(handler, {
          method: 'POST',
          path: '/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'auth_code_123',
            client_id: 'my-client',
          }),
        });

        expect(res.status).toBe(200);

        const entry = engine.getKeyEntry(
          asGroupScope('test-scope'),
          'test-provider',
          'access',
        );
        expect(entry).not.toBeNull();
        expect(entry!.authFields).toBeDefined();
        expect(entry!.authFields!.client_id).toBe('my-client');
        expect(entry!.authFields!.scope).toBe('read write');
      } finally {
        restoreLogger(spies);
      }
    });

    it('excludes transient fields from auto-capture', async () => {
      const spies = muteLogger();
      try {
        const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
        const provider = makeProvider();
        const rule = makeTokenExchangeRule();
        const handler = createHandler(provider, rule, engine);

        serverResponseOverride = {
          status: 200,
          body: JSON.stringify({
            access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
            token_type: 'Bearer',
          }),
        };

        const res = await executeHandler(handler, {
          method: 'POST',
          path: '/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'auth_code_xyz',
            code_verifier: 'verifier_abc',
            client_id: 'my-client',
          }),
        });

        expect(res.status).toBe(200);

        const entry = engine.getKeyEntry(
          asGroupScope('test-scope'),
          'test-provider',
          'access',
        );
        expect(entry).not.toBeNull();
        expect(entry!.authFields).toBeDefined();
        expect(entry!.authFields!.client_id).toBe('my-client');
        // Transient fields must not be captured
        expect(entry!.authFields!.grant_type).toBeUndefined();
        expect(entry!.authFields!.code).toBeUndefined();
        expect(entry!.authFields!.code_verifier).toBeUndefined();
      } finally {
        restoreLogger(spies);
      }
    });

    it('explicit fromRequest disables auto-capture', async () => {
      const spies = muteLogger();
      try {
        const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
        const provider: OAuthProvider = {
          ...makeProvider(),
          tokenFieldCapture: { fromRequest: ['client_id'] },
        };
        const rule = makeTokenExchangeRule();
        const handler = createHandler(provider, rule, engine);

        serverResponseOverride = {
          status: 200,
          body: JSON.stringify({
            access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
            token_type: 'Bearer',
          }),
        };

        const res = await executeHandler(handler, {
          method: 'POST',
          path: '/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'auth_code_xyz',
            client_id: 'my-client',
            audience: 'https://api.example.com',
          }),
        });

        expect(res.status).toBe(200);

        const entry = engine.getKeyEntry(
          asGroupScope('test-scope'),
          'test-provider',
          'access',
        );
        expect(entry).not.toBeNull();
        expect(entry!.authFields).toBeDefined();
        expect(entry!.authFields!.client_id).toBe('my-client');
        // audience would be auto-captured, but explicit fromRequest disables auto
        expect(entry!.authFields!.audience).toBeUndefined();
      } finally {
        restoreLogger(spies);
      }
    });

    it('explicit fromResponse overrides auto', async () => {
      const spies = muteLogger();
      try {
        const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
        const provider: OAuthProvider = {
          ...makeProvider(),
          tokenFieldCapture: { fromResponse: ['scope', 'organization'] },
        };
        const rule = makeTokenExchangeRule();
        const handler = createHandler(provider, rule, engine);

        serverResponseOverride = {
          status: 200,
          body: JSON.stringify({
            access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
            token_type: 'Bearer',
            scope: 'read write',
            organization: 'acme-corp',
          }),
        };

        const res = await executeHandler(handler, {
          method: 'POST',
          path: '/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'auth_code_xyz',
          }),
        });

        expect(res.status).toBe(200);

        const entry = engine.getKeyEntry(
          asGroupScope('test-scope'),
          'test-provider',
          'access',
        );
        expect(entry).not.toBeNull();
        expect(entry!.authFields).toBeDefined();
        expect(entry!.authFields!.scope).toBe('read write');
        expect(entry!.authFields!.organization).toBe('acme-corp');
      } finally {
        restoreLogger(spies);
      }
    });

    it('scopeInclude adds scopes', async () => {
      const spies = muteLogger();
      try {
        const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
        const provider: OAuthProvider = {
          ...makeProvider(),
          tokenFieldCapture: { scopeInclude: ['user:file_upload'] },
        };
        const rule = makeTokenExchangeRule();
        const handler = createHandler(provider, rule, engine);

        serverResponseOverride = {
          status: 200,
          body: JSON.stringify({
            access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
            token_type: 'Bearer',
            scope: 'user:profile',
          }),
        };

        const res = await executeHandler(handler, {
          method: 'POST',
          path: '/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'auth_code_xyz',
          }),
        });

        expect(res.status).toBe(200);

        const entry = engine.getKeyEntry(
          asGroupScope('test-scope'),
          'test-provider',
          'access',
        );
        expect(entry).not.toBeNull();
        expect(entry!.authFields).toBeDefined();
        expect(entry!.authFields!.scope).toBe('user:profile user:file_upload');
      } finally {
        restoreLogger(spies);
      }
    });

    it('scopeExclude removes scopes', async () => {
      const spies = muteLogger();
      try {
        const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
        const provider: OAuthProvider = {
          ...makeProvider(),
          tokenFieldCapture: { scopeExclude: ['org:create_api_key'] },
        };
        const rule = makeTokenExchangeRule();
        const handler = createHandler(provider, rule, engine);

        serverResponseOverride = {
          status: 200,
          body: JSON.stringify({
            access_token: 'real_access_abcdefghijklmnopqrstuvwxyz1234567890ab',
            token_type: 'Bearer',
            scope: 'org:create_api_key user:profile',
          }),
        };

        const res = await executeHandler(handler, {
          method: 'POST',
          path: '/oauth/token',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'auth_code_xyz',
          }),
        });

        expect(res.status).toBe(200);

        const entry = engine.getKeyEntry(
          asGroupScope('test-scope'),
          'test-provider',
          'access',
        );
        expect(entry).not.toBeNull();
        expect(entry!.authFields).toBeDefined();
        expect(entry!.authFields!.scope).toBe('user:profile');
      } finally {
        restoreLogger(spies);
      }
    });
  });

  describe('authorize-stub', () => {
    it('intercepts authorize URL and returns stub when resolver is set', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider('stub-provider');
      const rule = makeAuthorizeStubRule();
      const handler = createHandler(provider, rule, engine);

      // Track what the initiation callback receives
      let capturedUrl = '';
      let capturedProviderId = '';
      setOAuthInitiationResolver((scope) => {
        return (url, providerId, _sourceIP) => {
          capturedUrl = url;
          capturedProviderId = providerId;
        };
      });

      try {
        const res = await executeHandler(handler, {
          method: 'GET',
          path: '/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback',
          targetHost: 'auth.example.com',
          targetPort: serverPort,
        });

        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe('intercepted');
        expect(body.url).toContain('auth.example.com');
        expect(body.url).toContain('/oauth/authorize');
        expect(capturedProviderId).toBe('stub-provider');
        expect(capturedUrl).toContain('auth.example.com');
      } finally {
        setOAuthInitiationResolver(() => null);
      }
    });

    it('forwards authorize request when no resolver callback', async () => {
      const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
      const provider = makeProvider('forward-provider');
      const rule = makeAuthorizeStubRule();
      const handler = createHandler(provider, rule, engine);

      // No resolver set → callback returns null → passthrough
      setOAuthInitiationResolver(() => null);

      try {
        const res = await executeHandler(handler, {
          method: 'GET',
          path: '/oauth/authorize?client_id=abc',
          targetHost: '127.0.0.1',
          targetPort: serverPort,
        });

        // Should forward to upstream (test server returns 200 by default)
        expect(res.status).toBe(200);
        expect(lastRequest).not.toBeNull();
        expect(lastRequest!.url).toContain('/oauth/authorize');
      } finally {
        setOAuthInitiationResolver(() => null);
      }
    });
  });
});
