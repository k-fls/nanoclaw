/**
 * Tests for Claude's universal OAuth integration:
 * - wrapWithApiKeySupport
 * - generateSubstituteCredentials
 * - CLAUDE_OAUTH_PROVIDER definition
 */
import { describe, it, expect, beforeEach } from 'vitest';
import http from 'http';

import {
  CLAUDE_OAUTH_PROVIDER,
  CLAUDE_PROVIDER_ID,
  CLAUDE_SUBSTITUTE_CONFIG,
  wrapWithApiKeySupport,
  generateSubstituteCredentials,
} from './claude.js';
import { TokenSubstituteEngine, PersistentTokenResolver } from '../token-substitute.js';
import type { HostHandler } from '../../credential-proxy.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from '../oauth-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRequest(headers: Record<string, string> = {}): http.IncomingMessage {
  const { PassThrough } = require('stream');
  const req = new PassThrough() as any;
  req.headers = headers;
  req.method = 'POST';
  req.url = '/v1/messages';
  req.pipe = (dest: any) => dest;
  return req as http.IncomingMessage;
}

function mockResponse(): http.ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      res.headersSent = true;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  } as any;
  return res;
}

// ---------------------------------------------------------------------------
// CLAUDE_OAUTH_PROVIDER definition
// ---------------------------------------------------------------------------

describe('CLAUDE_OAUTH_PROVIDER', () => {
  it('has correct provider ID', () => {
    expect(CLAUDE_OAUTH_PROVIDER.id).toBe('claude');
  });

  it('has token-exchange rule for platform.claude.com', () => {
    const rule = CLAUDE_OAUTH_PROVIDER.rules.find(
      (r) => r.mode === 'token-exchange',
    );
    expect(rule).toBeDefined();
    expect(rule!.anchor).toBe('platform.claude.com');
    expect(rule!.pathPattern.test('/v1/oauth/token')).toBe(true);
    expect(rule!.pathPattern.test('/v1/messages')).toBe(false);
  });

  it('has bearer-swap rule for api.anthropic.com', () => {
    const rule = CLAUDE_OAUTH_PROVIDER.rules.find(
      (r) => r.mode === 'bearer-swap' && r.anchor === 'api.anthropic.com',
    );
    expect(rule).toBeDefined();
    expect(rule!.pathPattern.test('/v1/messages')).toBe(true);
  });

  it('has bearer-swap rule for platform.claude.com', () => {
    const rule = CLAUDE_OAUTH_PROVIDER.rules.find(
      (r) => r.mode === 'bearer-swap' && r.anchor === 'platform.claude.com',
    );
    expect(rule).toBeDefined();
  });

  it('has substitute config with 14-char prefix for sk-ant-* tokens', () => {
    expect(CLAUDE_SUBSTITUTE_CONFIG.prefixLen).toBe(14);
    expect(CLAUDE_SUBSTITUTE_CONFIG.suffixLen).toBe(0);
    expect(CLAUDE_SUBSTITUTE_CONFIG.delimiters).toBe('-_');
  });
});

// ---------------------------------------------------------------------------
// wrapWithApiKeySupport
// ---------------------------------------------------------------------------

describe('wrapWithApiKeySupport', () => {
  let resolver: PersistentTokenResolver;
  let engine: TokenSubstituteEngine;

  beforeEach(() => {
    resolver = new PersistentTokenResolver();
    engine = new TokenSubstituteEngine(resolver);
  });

  it('resolves x-api-key substitute and delegates to proxyPipe', async () => {
    const realKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sub = engine.generateSubstitute(realKey, CLAUDE_PROVIDER_ID, {}, 'scope', CLAUDE_SUBSTITUTE_CONFIG, 'api_key')!;
    expect(sub).not.toBeNull();

    // Track what the universal handler receives
    let universalCalled = false;
    const universalHandler: HostHandler = async () => { universalCalled = true; };

    const handler = wrapWithApiKeySupport(universalHandler, engine);

    // The handler calls proxyPipe which requires a real socket — we can't fully
    // test the pipe, but we can verify the universal handler is NOT called
    // (x-api-key path is taken instead)
    const req = mockRequest({ 'x-api-key': sub });
    const res = mockResponse();

    // This will throw because proxyPipe needs real sockets, but the important
    // thing is that universalHandler is NOT called
    try {
      await handler(req, res, 'api.anthropic.com', 443, 'scope');
    } catch {
      // Expected — proxyPipe can't actually connect
    }

    expect(universalCalled).toBe(false);
  });

  it('delegates to universal handler for Bearer tokens', async () => {
    let universalCalled = false;
    const universalHandler: HostHandler = async () => { universalCalled = true; };

    const handler = wrapWithApiKeySupport(universalHandler, engine);

    const req = mockRequest({ authorization: 'Bearer some-token' });
    const res = mockResponse();

    await handler(req, res, 'api.anthropic.com', 443, 'scope');

    expect(universalCalled).toBe(true);
  });

  it('delegates to universal handler when no auth header present', async () => {
    let universalCalled = false;
    const universalHandler: HostHandler = async () => { universalCalled = true; };

    const handler = wrapWithApiKeySupport(universalHandler, engine);

    const req = mockRequest({});
    const res = mockResponse();

    await handler(req, res, 'api.anthropic.com', 443, 'scope');

    expect(universalCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateSubstituteCredentials
// ---------------------------------------------------------------------------

describe('generateSubstituteCredentials', () => {
  // Note: these tests can't call the real claudeProvider.provision() because
  // the credential store isn't initialized. We test the token engine interaction
  // by verifying the function signature and substitute config are correct.

  it('CLAUDE_SUBSTITUTE_CONFIG preserves sk-ant-api prefix', () => {
    const resolver = new PersistentTokenResolver();
    const engine = new TokenSubstituteEngine(resolver);
    const real = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const sub = engine.generateSubstitute(real, CLAUDE_PROVIDER_ID, {}, 'scope', CLAUDE_SUBSTITUTE_CONFIG, 'api_key')!;
    expect(sub).not.toBeNull();
    // First 14 chars preserved: "sk-ant-api03-a"
    expect(sub.slice(0, 14)).toBe(real.slice(0, 14));
    expect(sub).not.toBe(real);
    expect(sub.length).toBe(real.length);
  });

  it('CLAUDE_SUBSTITUTE_CONFIG preserves sk-ant-oat prefix', () => {
    const resolver = new PersistentTokenResolver();
    const engine = new TokenSubstituteEngine(resolver);
    const real = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const sub = engine.generateSubstitute(real, CLAUDE_PROVIDER_ID, {}, 'scope', CLAUDE_SUBSTITUTE_CONFIG)!;
    expect(sub).not.toBeNull();
    expect(sub.slice(0, 14)).toBe(real.slice(0, 14));
  });

  it('CLAUDE_SUBSTITUTE_CONFIG preserves sk-ant-ort prefix for refresh tokens', () => {
    const resolver = new PersistentTokenResolver();
    const engine = new TokenSubstituteEngine(resolver);
    const real = 'sk-ant-ort01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const sub = engine.generateSubstitute(real, CLAUDE_PROVIDER_ID, {}, 'scope', CLAUDE_SUBSTITUTE_CONFIG, 'refresh')!;
    expect(sub).not.toBeNull();
    expect(sub.slice(0, 14)).toBe(real.slice(0, 14));
  });
});
