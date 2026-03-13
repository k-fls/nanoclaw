import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';

import { startMitmProxy, getMitmCaCertPath, CredentialRule } from './mitm-proxy.js';

import forge from 'node-forge';

function createSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

function proxyRequest(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  requestPath: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    caCert?: string;
  } = {},
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  const method = opts.method || 'GET';
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });

    connectReq.on('connect', (_res, socket) => {
      const tlsOptions = {
        hostname: targetHost,
        port: targetPort,
        path: requestPath,
        method,
        headers: { host: targetHost, ...(opts.headers || {}) },
        socket,
        agent: false,
        ca: opts.caCert ? [opts.caCert] : undefined,
        rejectUnauthorized: !!opts.caCert,
      } as https.RequestOptions;

      const req = https.request(tlsOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          socket.destroy();
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

// ---------------------------------------------------------------------------
// Static rules tests (existing functionality)
// ---------------------------------------------------------------------------

describe('mitm-proxy static rules', () => {
  let upstreamServer: https.Server;
  let proxyServer: http.Server;
  let upstreamPort: number;
  let proxyPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let caDir: string;
  const upstreamCert = createSelfSignedCert();

  beforeAll(async () => {
    upstreamServer = https.createServer(
      { key: upstreamCert.key, cert: upstreamCert.cert },
      (req, res) => {
        lastUpstreamHeaders = { ...req.headers };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      },
    );
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-test-ca-'));

    const rules = new Map<string, CredentialRule[]>();
    rules.set('127.0.0.1', [
      { header: 'authorization', value: 'Bearer secret-injected-token', stripExisting: true },
    ]);

    proxyServer = await startMitmProxy({
      port: 0,
      mitmHosts: new Set(['127.0.0.1']),
      rules,
      caDir,
      rejectUnauthorized: false,
    });
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    (proxyServer as any)?.closeAllConnections?.();
    (upstreamServer as any)?.closeAllConnections?.();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('injects credentials on targeted host', async () => {
    const caCertPem = fs.readFileSync(getMitmCaCertPath(caDir), 'utf-8');
    const res = await proxyRequest('127.0.0.1', proxyPort, '127.0.0.1', upstreamPort, '/v1/test', {
      headers: { authorization: 'Bearer placeholder' },
      caCert: caCertPem,
    });
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer secret-injected-token');
  });

  it('TCP tunnels non-targeted hosts', async () => {
    const res = await proxyRequest('127.0.0.1', proxyPort, 'localhost', upstreamPort, '/tunneled', {
      headers: { authorization: 'Bearer should-not-be-stripped' },
    });
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer should-not-be-stripped');
  });

  it('CA cert file is persisted', () => {
    const pem = fs.readFileSync(getMitmCaCertPath(caDir), 'utf-8');
    expect(pem).toContain('BEGIN CERTIFICATE');
  });
});

// ---------------------------------------------------------------------------
// OAuth interceptor tests
// ---------------------------------------------------------------------------

describe('mitm-proxy OAuth', () => {
  let upstreamServer: https.Server;
  let proxyServer: http.Server;
  let upstreamPort: number;
  let proxyPort: number;
  let caDir: string;
  let caCertPem: string;
  const upstreamCert = createSelfSignedCert();

  // Track what upstream received
  let lastUpstreamReq: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

  // Token storage (simulates host-side credential store)
  const tokenStore = {
    realAccess: 'ya29.real-access-token',
    realRefresh: '1//real-refresh-token',
    subAccess: 'sub-access-001',
    subRefresh: 'sub-refresh-001',
    // After refresh
    realAccess2: 'ya29.refreshed-access-token',
    subAccess2: 'sub-access-002',
  };

  // Track callback invocations
  let authorizeCallCount = 0;
  let tokensCallCount = 0;
  let resolveAccessCount = 0;
  let resolveRefreshCount = 0;

  beforeAll(async () => {
    authorizeCallCount = 0;
    tokensCallCount = 0;
    resolveAccessCount = 0;
    resolveRefreshCount = 0;

    // Upstream server simulates both auth server and API
    upstreamServer = https.createServer(
      { key: upstreamCert.key, cert: upstreamCert.cert },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          lastUpstreamReq = {
            method: req.method!,
            url: req.url!,
            headers: { ...req.headers },
            body: Buffer.concat(chunks).toString(),
          };

          // Token endpoint responses
          if (req.url === '/token' && req.method === 'POST') {
            const body = lastUpstreamReq.body;
            if (body.includes('grant_type=authorization_code')) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                access_token: tokenStore.realAccess,
                refresh_token: tokenStore.realRefresh,
                expires_in: 3600,
                token_type: 'Bearer',
                scope: 'openid email',
              }));
              return;
            }
            if (body.includes('grant_type=refresh_token')) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                access_token: tokenStore.realAccess2,
                refresh_token: tokenStore.realRefresh,
                expires_in: 3600,
                token_type: 'Bearer',
              }));
              return;
            }
          }

          // API endpoint
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: req.url }));
        });
      },
    );
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-oauth-test-'));

    proxyServer = await startMitmProxy({
      port: 0,
      mitmHosts: new Set(['127.0.0.1']),
      caDir,
      rejectUnauthorized: false,
      oauthProviders: [
        {
          id: 'test-provider',
          tokenEndpoint: /^127\.0\.0\.1\/token$/,
          authorizeEndpoint: /^127\.0\.0\.1\/authorize/,
          protectedUrls: /^127\.0\.0\.1\/api\//,
          callbacks: {
            async onAuthorize(params) {
              authorizeCallCount++;
              // Return a stub 302 redirect with an auth code
              return {
                action: 'stub',
                response: {
                  statusCode: 302,
                  headers: {
                    location: `${params.redirect_uri}?code=host-obtained-code&state=${params.state}`,
                  },
                  body: '',
                },
              };
            },
            async onTokens(real) {
              tokensCallCount++;
              // Store real tokens, return substitutes
              return {
                ...real,
                access_token: tokensCallCount === 1 ? tokenStore.subAccess : tokenStore.subAccess2,
                refresh_token: real.refresh_token ? tokenStore.subRefresh : undefined,
              };
            },
            async resolveRefreshToken(substitute) {
              resolveRefreshCount++;
              if (substitute === tokenStore.subRefresh) return tokenStore.realRefresh;
              return substitute;
            },
            async resolveAccessToken(substitute) {
              resolveAccessCount++;
              if (substitute === tokenStore.subAccess) return tokenStore.realAccess;
              if (substitute === tokenStore.subAccess2) return tokenStore.realAccess2;
              return null;
            },
          },
        },
      ],
    });
    proxyPort = (proxyServer.address() as AddressInfo).port;
    caCertPem = fs.readFileSync(getMitmCaCertPath(caDir), 'utf-8');
  });

  afterAll(async () => {
    (proxyServer as any)?.closeAllConnections?.();
    (upstreamServer as any)?.closeAllConnections?.();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('authorize-stub: returns stub for authorize endpoint', async () => {
    const res = await proxyRequest(
      '127.0.0.1', proxyPort, '127.0.0.1', upstreamPort,
      '/authorize?client_id=myapp&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&response_type=code&scope=openid&state=xyz123',
      { caCert: caCertPem },
    );

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(
      'http://localhost:8080/callback?code=host-obtained-code&state=xyz123',
    );
    expect(authorizeCallCount).toBe(1);
  });

  it('token-exchange: token exchange — captures real tokens, returns substitutes', async () => {
    const res = await proxyRequest(
      '127.0.0.1', proxyPort, '127.0.0.1', upstreamPort,
      '/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=host-obtained-code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&client_id=myapp&client_secret=mysecret',
        caCert: caCertPem,
      },
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Container receives substitute tokens
    expect(body.access_token).toBe(tokenStore.subAccess);
    expect(body.refresh_token).toBe(tokenStore.subRefresh);
    // Other fields preserved
    expect(body.expires_in).toBe(3600);
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('openid email');

    // Upstream received the original request untouched
    expect(lastUpstreamReq.body).toContain('client_secret=mysecret');
    expect(lastUpstreamReq.body).toContain('code=host-obtained-code');

    expect(tokensCallCount).toBe(1);
  });

  it('token-exchange: refresh — swaps substitute refresh token outbound, captures new tokens', async () => {
    const res = await proxyRequest(
      '127.0.0.1', proxyPort, '127.0.0.1', upstreamPort,
      '/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${tokenStore.subRefresh}&client_id=myapp&client_secret=mysecret`,
        caCert: caCertPem,
      },
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Container receives new substitute access token
    expect(body.access_token).toBe(tokenStore.subAccess2);
    // Refresh token substitute preserved
    expect(body.refresh_token).toBe(tokenStore.subRefresh);

    // Upstream received the REAL refresh token (not substitute)
    expect(lastUpstreamReq.body).toContain(`refresh_token=${encodeURIComponent(tokenStore.realRefresh)}`);
    // Client secret preserved untouched
    expect(lastUpstreamReq.body).toContain('client_secret=mysecret');

    expect(resolveRefreshCount).toBe(1);
    expect(tokensCallCount).toBe(2); // second call from refresh
  });

  it('bearer-swap: swaps Bearer header on API calls, pipes body', async () => {
    const res = await proxyRequest(
      '127.0.0.1', proxyPort, '127.0.0.1', upstreamPort,
      '/api/v1/resources',
      {
        headers: { authorization: `Bearer ${tokenStore.subAccess}` },
        caCert: caCertPem,
      },
    );

    expect(res.statusCode).toBe(200);
    // Upstream received the REAL access token
    expect(lastUpstreamReq.headers['authorization']).toBe(`Bearer ${tokenStore.realAccess}`);
    expect(resolveAccessCount).toBe(1);
  });

  it('bearer-swap: unknown substitute token passed through', async () => {
    const res = await proxyRequest(
      '127.0.0.1', proxyPort, '127.0.0.1', upstreamPort,
      '/api/v1/resources',
      {
        headers: { authorization: 'Bearer unknown-token-xyz' },
        caCert: caCertPem,
      },
    );

    expect(res.statusCode).toBe(200);
    // resolveAccessToken returned null, so header passed through unmodified
    expect(lastUpstreamReq.headers['authorization']).toBe('Bearer unknown-token-xyz');
  });

  it('non-matching URL falls through to no modification', async () => {
    const res = await proxyRequest(
      '127.0.0.1', proxyPort, '127.0.0.1', upstreamPort,
      '/some/other/path',
      {
        headers: { authorization: 'Bearer whatever' },
        caCert: caCertPem,
      },
    );

    expect(res.statusCode).toBe(200);
    // No OAuth regex matched, no static rules either — passed through
    expect(lastUpstreamReq.headers['authorization']).toBe('Bearer whatever');
  });
});
