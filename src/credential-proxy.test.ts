import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { CredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Class unit tests — no server needed
// ---------------------------------------------------------------------------

describe('CredentialProxy class', () => {
  let proxy: CredentialProxy;

  beforeEach(() => {
    proxy = new CredentialProxy();
  });

  describe('shouldIntercept', () => {
    it('matches registered hostnames', () => {
      proxy.registerProviderHost(/^api\.anthropic\.com$/, /^\//, async () => {});
      proxy.registerProviderHost(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, async () => {});

      expect(proxy.shouldIntercept('api.anthropic.com')).toBe(true);
      expect(proxy.shouldIntercept('console.anthropic.com')).toBe(true);
    });

    it('does not match unregistered hostnames', () => {
      proxy.registerProviderHost(/^api\.anthropic\.com$/, /^\//, async () => {});

      expect(proxy.shouldIntercept('github.com')).toBe(false);
      expect(proxy.shouldIntercept('example.com')).toBe(false);
    });

    it('does not partial-match hostnames', () => {
      proxy.registerProviderHost(/^api\.anthropic\.com$/, /^\//, async () => {});

      expect(proxy.shouldIntercept('evil-api.anthropic.com')).toBe(false);
      expect(proxy.shouldIntercept('api.anthropic.com.evil.com')).toBe(false);
    });
  });

  describe('matchHostRule', () => {
    it('matches host + path', () => {
      proxy.registerProviderHost(/^api\.anthropic\.com$/, /^\//, async () => {});
      proxy.registerProviderHost(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, async () => {});

      expect(proxy.matchHostRule('api.anthropic.com', '/v1/messages')).not.toBeNull();
      expect(proxy.matchHostRule('console.anthropic.com', '/api/oauth/token')).not.toBeNull();
    });

    it('does not match console.anthropic.com for non-token paths', () => {
      proxy.registerProviderHost(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, async () => {});

      expect(proxy.matchHostRule('console.anthropic.com', '/dashboard')).toBeNull();
      expect(proxy.matchHostRule('console.anthropic.com', '/')).toBeNull();
    });

    it('returns null for unregistered hosts', () => {
      expect(proxy.matchHostRule('github.com', '/api/v3')).toBeNull();
    });
  });

  describe('resolveScope', () => {
    it('returns null for unknown IPs', () => {
      expect(proxy.resolveScope('10.99.99.99')).toBeNull();
    });

    it('returns registered scope', () => {
      proxy.registerContainerIP('172.17.0.5', 'test-group');
      expect(proxy.resolveScope('172.17.0.5')).toBe('test-group');
    });

    it('normalizes IPv4-mapped IPv6', () => {
      proxy.registerContainerIP('172.17.0.6', 'ipv6-group');
      expect(proxy.resolveScope('::ffff:172.17.0.6')).toBe('ipv6-group');
    });
  });

  describe('detectAuthMode', () => {
    it('returns api-key when ANTHROPIC_API_KEY present', () => {
      proxy.setCredentialResolver(() => ({ ANTHROPIC_API_KEY: 'sk-test' }));
      expect(proxy.detectAuthMode('any')).toBe('api-key');
    });

    it('returns oauth when no API key', () => {
      proxy.setCredentialResolver(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'token' }));
      expect(proxy.detectAuthMode('any')).toBe('oauth');
    });
  });

  describe('unregisterContainerIP', () => {
    it('removes the mapping', () => {
      proxy.registerContainerIP('172.17.0.7', 'temp');
      proxy.unregisterContainerIP('172.17.0.7');
      expect(proxy.resolveScope('172.17.0.7')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy integration tests
// ---------------------------------------------------------------------------

describe('credential-proxy HTTP server', () => {
  let proxy: CredentialProxy;
  let proxyServer: import('net').Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamPath: string;

  beforeEach(async () => {
    proxy = new CredentialProxy();
    lastUpstreamHeaders = {};
    lastUpstreamPath = '';

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
  });

  it('serves /health without caller validation', async () => {
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(proxyPort, { method: 'GET', path: '/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('rejects HTTP proxy requests from unknown container IP with 403', async () => {
    // 127.0.0.1 is NOT registered as a container IP
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/v1/test`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('forwards HTTP proxy requests from known container IP', async () => {
    proxy.registerContainerIP('127.0.0.1', 'my-group');
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/v1/test`,
    });

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamPath).toBe('/v1/test');
  });

  it('does not inject credentials on HTTP proxy requests', async () => {
    proxy.registerContainerIP('127.0.0.1', 'my-group');
    proxy.setCredentialResolver(() => ({ ANTHROPIC_API_KEY: 'real-key' }));
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/v1/test`,
      headers: { 'x-api-key': 'placeholder' },
    });

    // HTTP proxy is transparent — no credential injection
    expect(lastUpstreamHeaders['x-api-key']).toBe('placeholder');
  });
});
