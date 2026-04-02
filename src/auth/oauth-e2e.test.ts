/**
 * Docker-based e2e tests for the OAuth proxy system.
 *
 * Prerequisites:
 *   - Docker running
 *   - nanoclaw-agent image built (./container/build.sh)
 *
 * Tests are auto-skipped if Docker or the image is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import {
  OAuthE2EHarness,
  isDockerAvailable,
  isImageAvailable,
} from './e2e-harness.js';
import type { OAuthProvider, SubstituteConfig } from './oauth-types.js';

// ---------------------------------------------------------------------------
// Test provider definition
// ---------------------------------------------------------------------------

const TEST_SUBSTITUTE_CONFIG: SubstituteConfig = {
  prefixLen: 14,
  suffixLen: 0,
  delimiters: '-_',
};

const TEST_PROVIDER: OAuthProvider = {
  id: 'test-claude',
  rules: [
    {
      anchor: 'api.anthropic.com',
      pathPattern: /^\/.*$/,
      mode: 'bearer-swap' as const,
    },
    {
      anchor: 'platform.claude.com',
      pathPattern: /^\/v1\/oauth\/token$/,
      mode: 'token-exchange' as const,
    },
  ],
  scopeKeys: [],
  substituteConfig: TEST_SUBSTITUTE_CONFIG,
  refreshStrategy: 'redirect',
};

// ---------------------------------------------------------------------------
// Test scope & tokens
// ---------------------------------------------------------------------------

const SCOPE = 'e2e-test';
// Must be long enough for format-preserving substitution (>= 14 prefix + 16 random)
const REAL_ACCESS_TOKEN =
  'sk-ant-api03-realAccessTokenForE2ETesting1234567890abcdef';
const REAL_REFRESH_TOKEN =
  'sk-ant-ort01-realRefreshTokenE2ETesting1234567890abcdef';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const canRun = isDockerAvailable() && isImageAvailable();

describe.skipIf(!canRun)('OAuth e2e (Docker)', () => {
  let h: OAuthE2EHarness;

  beforeAll(async () => {
    h = new OAuthE2EHarness();
    await h.start();
    h.registerProvider(TEST_PROVIDER);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  }, 15_000);

  beforeEach(() => {
    h.reset();
  });

  // ── 1. Bearer-swap: substitute → real → upstream ─────────────────

  it('bearer-swap swaps substitute token for real token', async () => {
    const substitute = h.storeToken(
      REAL_ACCESS_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
    );

    // Default mock response: 200 OK
    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/messages/,
      respond: () => ({
        status: 200,
        body: '{"id":"msg_ok","content":"hello"}',
      }),
    });

    const result = await h.runInContainer(
      `curl -s -o /dev/stdout -w '\\n%{http_code}' ` +
        `-H "Authorization: Bearer ${substitute}" ` +
        `-H "Content-Type: application/json" ` +
        `https://api.anthropic.com/v1/messages`,
      { scope: SCOPE },
    );

    // Container should get 200
    const lines = result.stdout.trim().split('\n');
    const httpCode = lines[lines.length - 1];
    expect(httpCode).toBe('200');

    // Mock upstream should have received the REAL token, not the substitute
    const reqs = h.mockUpstream.getRequests(/\/v1\/messages/);
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    const authHeader = reqs[0].headers['authorization'];
    expect(authHeader).toBe(`Bearer ${REAL_ACCESS_TOKEN}`);
    // Substitute must NOT appear at upstream
    expect(authHeader).not.toContain(substitute);
  }, 45_000);

  // ── 2. Bearer-swap 401 → refresh → 307 → retry ──────────────────

  it('bearer-swap refreshes on 401 and retries via 307', async () => {
    const substitute = h.storeToken(
      REAL_ACCESS_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
    );
    h.storeToken(
      REAL_REFRESH_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
      'refresh',
    );

    const NEW_ACCESS = 'sk-ant-api03-freshAccessTokenAfterRefresh1234567890xyz';
    let callCount = 0;

    // First call to /v1/messages → 401, second → 200
    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/messages/,
      respond: () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 401,
            body: JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid token' },
              request_id: 'req_test_401',
            }),
          };
        }
        return { status: 200, body: '{"id":"msg_ok","content":"refreshed"}' };
      },
    });

    // Token endpoint → return fresh tokens
    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/oauth\/token/,
      respond: (req) => {
        // Verify we received the real refresh token
        const parsed = JSON.parse(req.body);
        expect(parsed.grant_type).toBe('refresh_token');
        expect(parsed.refresh_token).toBe(REAL_REFRESH_TOKEN);
        return {
          status: 200,
          body: JSON.stringify({
            access_token: NEW_ACCESS,
            refresh_token: REAL_REFRESH_TOKEN,
          }),
        };
      },
    });

    // curl -L follows 307 redirects (same host, so auth header preserved)
    const result = await h.runInContainer(
      `curl -s -L -o /dev/stdout -w '\\n%{http_code}' ` +
        `-H "Authorization: Bearer ${substitute}" ` +
        `-H "Content-Type: application/json" ` +
        `https://api.anthropic.com/v1/messages`,
      { scope: SCOPE },
    );

    const lines = result.stdout.trim().split('\n');
    const httpCode = lines[lines.length - 1];
    expect(httpCode).toBe('200');

    // Token endpoint should have been called
    const tokenReqs = h.mockUpstream.getRequests(/\/v1\/oauth\/token/);
    expect(tokenReqs.length).toBeGreaterThanOrEqual(1);

    // Second /v1/messages call should have the NEW access token
    const msgReqs = h.mockUpstream.getRequests(/\/v1\/messages/);
    expect(msgReqs.length).toBe(2);
    expect(msgReqs[1].headers['authorization']).toBe(`Bearer ${NEW_ACCESS}`);
  }, 45_000);

  // ── 2b. Same as above but POST — 307 must preserve method and body ─

  it('bearer-swap 307 preserves POST method and body', async () => {
    const substitute = h.storeToken(
      REAL_ACCESS_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
    );
    h.storeToken(
      REAL_REFRESH_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
      'refresh',
    );

    const NEW_ACCESS = 'sk-ant-api03-freshAccessTokenAfterRefresh1234567890xyz';
    let callCount = 0;

    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/messages/,
      respond: (req) => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 401,
            body: JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid token' },
              request_id: 'req_post_401',
            }),
          };
        }
        // Verify the retried request is still POST with the original body
        expect(req.method).toBe('POST');
        const body = JSON.parse(req.body);
        expect(body.model).toBe('claude-sonnet-4-20250514');
        expect(body.messages[0].content).toBe('hello');
        return {
          status: 200,
          body: '{"id":"msg_ok","content":"post-refreshed"}',
        };
      },
    });

    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/oauth\/token/,
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          access_token: NEW_ACCESS,
          refresh_token: REAL_REFRESH_TOKEN,
        }),
      }),
    });

    const postBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });

    const result = await h.runInContainer(
      `curl -s -L -X POST -o /dev/stdout -w '\\n%{http_code}' ` +
        `-H "Authorization: Bearer ${substitute}" ` +
        `-H "Content-Type: application/json" ` +
        `-d '${postBody}' ` +
        `https://api.anthropic.com/v1/messages`,
      { scope: SCOPE },
    );

    const lines = result.stdout.trim().split('\n');
    const httpCode = lines[lines.length - 1];
    expect(httpCode).toBe('200');

    const msgReqs = h.mockUpstream.getRequests(/\/v1\/messages/);
    expect(msgReqs.length).toBe(2);
    expect(msgReqs[1].method).toBe('POST');
    expect(msgReqs[1].headers['authorization']).toBe(`Bearer ${NEW_ACCESS}`);
  }, 45_000);

  // ── 3. Bearer-swap 401 → refresh fails → error forwarded ────────

  it('returns error to container when bearer-swap gets 401', async () => {
    const substitute = h.storeToken(
      REAL_ACCESS_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
    );

    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/messages/,
      respond: () => ({
        status: 401,
        body: JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid token' },
          request_id: 'req_xyz_123',
        }),
      }),
    });

    const result = await h.runInContainer(
      `curl -s -w '\\n%{http_code}' https://api.anthropic.com/v1/messages ` +
        `-H "Authorization: Bearer ${substitute}" ` +
        `-H "Content-Type: application/json"`,
      { scope: SCOPE },
    );

    // Handler returns an error response to the container
    const lines = result.stdout.trim().split('\n');
    const httpCode = lines[lines.length - 1];
    const body = lines.slice(0, -1).join('\n');

    // The handler sees 401, attempts refresh (fails — no refresh token stored),
    // and returns an error to the container
    expect(parseInt(httpCode)).toBeGreaterThanOrEqual(400);
    expect(body).toBeTruthy();
    const parsed = JSON.parse(body);
    expect(parsed.error).toBeDefined();
  }, 45_000);

  // ── 4. Token-exchange: substitute refresh → real → new substitutes ─

  it('token-exchange swaps refresh tokens both directions', async () => {
    const subRefresh = h.storeToken(
      REAL_REFRESH_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
      'refresh',
    );

    const NEW_ACCESS = 'sk-ant-api03-brandNewAccessFromTokenExchange1234567890';
    const NEW_REFRESH =
      'sk-ant-ort01-brandNewRefreshFromTokenExchange123456789';

    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/oauth\/token/,
      respond: (req) => {
        const body = JSON.parse(req.body);
        // Must receive REAL refresh token, not substitute
        expect(body.refresh_token).toBe(REAL_REFRESH_TOKEN);
        return {
          status: 200,
          body: JSON.stringify({
            access_token: NEW_ACCESS,
            refresh_token: NEW_REFRESH,
            expires_in: 3600,
          }),
        };
      },
    });

    const result = await h.runInContainer(
      `curl -s -X POST https://platform.claude.com/v1/oauth/token ` +
        `-H "Content-Type: application/json" ` +
        `-d '${JSON.stringify({ grant_type: 'refresh_token', refresh_token: subRefresh })}'`,
      { scope: SCOPE },
    );

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(result.stdout);

    // Container should get SUBSTITUTES, not real tokens
    expect(response.access_token).toBeDefined();
    expect(response.refresh_token).toBeDefined();
    expect(response.access_token).not.toBe(NEW_ACCESS);
    expect(response.refresh_token).not.toBe(NEW_REFRESH);
    // Substitutes preserve prefix
    expect(response.access_token.startsWith('sk-ant-api03-b')).toBe(true);
    expect(response.refresh_token.startsWith('sk-ant-ort01-b')).toBe(true);
    expect(response.expires_in).toBe(3600);
  }, 45_000);

  // ── 5. Browser-open: known OAuth URL → queue push ────────────────

  it('xdg-open shim pushes known OAuth URL to flow queue', async () => {
    h.registerAuthPattern(
      /^https:\/\/accounts\.google\.com\/o\/oauth2/,
      'google',
    );

    const result = await h.runInContainer(
      `xdg-open "https://accounts.google.com/o/oauth2/v2/auth?client_id=foo&redirect_uri=http%3A%2F%2Flocalhost%3A9999"`,
      { scope: SCOPE },
    );

    expect(result.exitCode).toBe(0);
    expect(h.browserOpenEvents.length).toBe(1);
    expect(h.browserOpenEvents[0].url).toContain('accounts.google.com');
    expect(h.browserOpenEvents[0].scope).toBe(SCOPE);
    expect(h.flowQueue.length).toBe(1);
  }, 45_000);

  // ── 6. Browser-open: unknown URL → passthrough ───────────────────

  it('xdg-open shim passes through unknown URLs', async () => {
    const result = await h.runInContainer(
      `xdg-open "https://example.com/not-oauth" ; echo "exit:$?"`,
      { scope: SCOPE },
    );

    // Shim should NOT push to queue
    expect(h.browserOpenEvents.length).toBe(0);
    expect(h.flowQueue.length).toBe(0);
    // Shim falls through to xdg-open.real (which doesn't exist) → exit 1
    expect(result.stdout).toContain('exit:1');
  }, 45_000);

  // ── 7. Scope isolation ───────────────────────────────────────────

  it('tokens from scope A are not resolvable from scope B', async () => {
    const substitute = h.storeToken(
      REAL_ACCESS_TOKEN,
      'test-claude',
      'group-a',
      TEST_SUBSTITUTE_CONFIG,
    );

    // Track what the mock sees
    let receivedAuth = '';
    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/messages/,
      respond: (req) => {
        receivedAuth = req.headers['authorization'] || '';
        return { status: 200, body: '{"ok":true}' };
      },
    });

    // Run container as scope group-b, using group-a's substitute
    const result = await h.runInContainer(
      `curl -s -o /dev/stdout -w '\\n%{http_code}' ` +
        `-H "Authorization: Bearer ${substitute}" ` +
        `https://api.anthropic.com/v1/messages`,
      { scope: 'group-b' },
    );

    // The proxy should NOT have resolved the substitute (wrong scope)
    // Upstream sees the substitute as-is, not the real token
    expect(receivedAuth).toBe(`Bearer ${substitute}`);
    expect(receivedAuth).not.toContain(REAL_ACCESS_TOKEN);
  }, 45_000);

  // ── 8. Proxy tap logger ──────────────────────────────────────────

  it('tap logger writes request and response headers to JSONL', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const { createTapFilter } = await import('../proxy-tap-logger.js');

    const substitute = h.storeToken(
      REAL_ACCESS_TOKEN,
      'test-claude',
      SCOPE,
      TEST_SUBSTITUTE_CONFIG,
    );

    // Set up JSONL tap logger to a temp file
    const logFile = path.join(os.tmpdir(), `tap-e2e-${Date.now()}.jsonl`);
    h.proxy.setTapFilter(
      createTapFilter(/anthropic/, /\/v1\/messages/, logFile),
    );

    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/messages/,
      respond: () => ({
        status: 200,
        body: '{"id":"msg_tap","content":"tapped"}',
      }),
    });

    await h.runInContainer(
      `curl -s -H "Authorization: Bearer ${substitute}" ` +
        `-H "Content-Type: application/json" ` +
        `https://api.anthropic.com/v1/messages`,
      { scope: SCOPE },
    );

    // Give a moment for the sync write to flush
    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const lines = content.split('\n').map((l: string) => JSON.parse(l));

    // Should have request (inbound) and response (outbound) entries
    const req = lines.find((l: any) => l.direction === 'inbound');
    const res = lines.find((l: any) => l.direction === 'outbound');

    expect(req).toBeDefined();
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/v1/messages');
    expect(req.host).toBe('api.anthropic.com');
    expect(req.scope).toBe(SCOPE);
    expect(req.headers).toBeDefined();
    expect(req.ts).toMatch(/^\d{4}-/);

    expect(res).toBeDefined();
    expect(res.statusCode).toBe(200);
    expect(res.host).toBe('api.anthropic.com');
    expect(res.headers).toBeDefined();

    // Clean up
    h.proxy.setTapFilter(null);
    fs.unlinkSync(logFile);
  }, 45_000);

  // ── 9. Auth container: token exchange captures authFields ─────────

  it('token exchange captures authFields (client_id, scope) for refresh', async () => {
    const { asGroupScope } = await import('./oauth-types.js');
    const groupScope = asGroupScope(SCOPE);

    // Real tokens the mock upstream returns
    const REAL_ACCESS =
      'sk-ant-oat01-authContainerE2eAccessToken1234567890abcdef';
    const REAL_REFRESH =
      'sk-ant-ort01-authContainerE2eRefreshToken1234567890abcdef';

    // Mock upstream: token exchange returns real tokens + scope
    h.mockUpstream.addRoute({
      pathPattern: /^\/v1\/oauth\/token/,
      respond: (req) => {
        const body = JSON.parse(req.body);
        expect(body.grant_type).toBe('authorization_code');
        expect(body.client_id).toBe('test-client-id');
        return {
          status: 200,
          body: JSON.stringify({
            access_token: REAL_ACCESS,
            refresh_token: REAL_REFRESH,
            expires_in: 28800,
            scope: 'user:inference user:profile',
          }),
        };
      },
    });

    // Run a curl token exchange inside a container (same proxy path as auth containers)
    const result = await h.runInContainer(
      `curl -sf -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"grant_type":"authorization_code","code":"test_code","client_id":"test-client-id"}' ` +
        `https://platform.claude.com/v1/oauth/token`,
      { scope: SCOPE },
    );

    expect(result.exitCode).toBe(0);

    // Parse the response the container received — should be substitutes, not real tokens
    const response = JSON.parse(result.stdout.trim());
    expect(response.access_token).toBeDefined();
    expect(response.refresh_token).toBeDefined();
    // Substitutes preserve prefix but differ from real tokens
    expect(response.access_token.startsWith('sk-ant-oat01-')).toBe(true);
    expect(response.access_token).not.toBe(REAL_ACCESS);
    expect(response.refresh_token.startsWith('sk-ant-ort01-')).toBe(true);
    expect(response.refresh_token).not.toBe(REAL_REFRESH);

    // Verify the proxy stored real tokens with authFields
    const accessEntry = h.tokenEngine.getKeyEntry(
      groupScope,
      'test-claude',
      'access',
    );
    expect(accessEntry).not.toBeNull();
    expect(accessEntry!.authFields).toBeDefined();
    expect(accessEntry!.authFields!.client_id).toBe('test-client-id');
    expect(accessEntry!.authFields!.scope).toContain('user:inference');

    // Verify substitutes resolve back to real tokens
    const accessResolved = h.tokenEngine.resolveSubstitute(
      response.access_token,
      groupScope,
    );
    expect(accessResolved).not.toBeNull();
    expect(accessResolved!.realToken).toBe(REAL_ACCESS);

    const refreshResolved = h.tokenEngine.resolveSubstitute(
      response.refresh_token,
      groupScope,
    );
    expect(refreshResolved).not.toBeNull();
    expect(refreshResolved!.realToken).toBe(REAL_REFRESH);
  }, 45_000);

  // ── 10. docker exec callback delivery + xdg-open-auth shim ────────

  it('docker exec curl delivers callback to container localhost via xdg-open-auth shim', async () => {
    const PORT = 19876;
    const OAUTH_URL = `https://example.com/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A${PORT}%2Fcallback`;

    // Setup: copy auth shim + listener script into IPC dir (mounted at /workspace/ipc)
    const { resolveGroupIpcPath } = await import('../group-folder.js');
    const ipcDir = resolveGroupIpcPath(SCOPE);
    const fsMod = await import('fs');
    const pathMod = await import('path');

    const shimSrc = pathMod.join(
      process.cwd(),
      'container',
      'shims',
      'xdg-open-auth',
    );
    const shimContent = fsMod
      .readFileSync(shimSrc, 'utf-8')
      .replace('/workspace/auth-ipc/.oauth-url', '/workspace/ipc/.oauth-url');
    fsMod.writeFileSync(pathMod.join(ipcDir, 'xdg-open-auth'), shimContent, {
      mode: 0o755,
    });
    try {
      fsMod.unlinkSync(pathMod.join(ipcDir, '.oauth-url'));
    } catch {}

    const listenerScript = [
      `const s = require('http').createServer((q,r) => {`,
      `  require('fs').writeFileSync('/tmp/cb', q.url);`,
      `  r.end('ok');`,
      `});`,
      `s.listen(${PORT}, '127.0.0.1', () => {`,
      `  require('fs').writeFileSync('/tmp/listening', '1');`,
      `});`,
      `setTimeout(() => process.exit(0), 30000);`,
    ].join('\n');
    fsMod.writeFileSync(pathMod.join(ipcDir, 'listener.js'), listenerScript);

    // Container: start listener, run shim (verifies port, writes .oauth-url), then wait.
    // Host will read .oauth-url and deliver callback via docker exec.
    const container = await h.startContainer(
      `node /workspace/ipc/listener.js &
       for i in $(seq 1 20); do [ -f /tmp/listening ] && break; sleep 0.1; done &&
       /workspace/ipc/xdg-open-auth "${OAUTH_URL}" &&
       wait`,
      { scope: SCOPE },
    );

    try {
      // Host: poll .oauth-url written by the shim (via IPC mount)
      const oauthUrlPath = pathMod.join(ipcDir, '.oauth-url');
      let shimUrl = '';
      for (let i = 0; i < 30; i++) {
        try {
          shimUrl = fsMod.readFileSync(oauthUrlPath, 'utf-8').trim();
        } catch {}
        if (shimUrl) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(shimUrl).toContain(`localhost%3A${PORT}`);

      // Host: deliver callback via docker exec (production mechanism)
      const execResult = h.execInContainer(
        container.containerName,
        `curl -sf "http://localhost:${PORT}/callback?code=testcode123&state=teststate456"`,
      );
      expect(execResult.exitCode).toBe(0);

      // Verify the listener received the callback
      const cbResult = h.execInContainer(
        container.containerName,
        'cat /tmp/cb',
      );
      expect(cbResult.stdout).toContain('code=testcode123');
      expect(cbResult.stdout).toContain('state=teststate456');
    } finally {
      await container.stop();
    }
  }, 60_000);
});
