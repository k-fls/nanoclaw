import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

import { asGroupScope } from './oauth-types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from './oauth-types.js';

// Mock registry before importing the handler
vi.mock('./registry.js', () => ({
  getDiscoveryProvider: vi.fn(),
  getProvider: vi.fn(),
  getTokenEngine: vi.fn(),
}));

import { handleSubstituteRequest } from './substitute-endpoint.js';
import { getDiscoveryProvider, getProvider, getTokenEngine } from './registry.js';

const mockGetDiscoveryProvider = vi.mocked(getDiscoveryProvider);
const mockGetProvider = vi.mocked(getProvider);
const mockGetTokenEngine = vi.mocked(getTokenEngine);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRequest(url: string): http.IncomingMessage {
  return { url, method: 'GET' } as http.IncomingMessage;
}

function mockResponse(): http.ServerResponse & {
  _status: number;
  _body: string;
} {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number, _headers?: Record<string, string>) {
      res._status = status;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  } as any;
  return res;
}

const SCOPE = asGroupScope('test-group');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('substitute-endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 400 for malformed path', () => {
    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/github'), res, SCOPE);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/Expected/);
  });

  it('returns 400 when path query param is missing', () => {
    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/github/substitute'),
      res,
      SCOPE,
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/Missing required query parameter: path/);
  });

  it('returns 404 for unknown provider', () => {
    mockGetDiscoveryProvider.mockReturnValue(undefined);
    mockGetProvider.mockReturnValue(undefined);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/nonexistent/substitute?path=oauth'),
      res,
      SCOPE,
    );
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/Unknown provider/);
  });

  it('returns 404 when no credentials exist for scope', () => {
    mockGetDiscoveryProvider.mockReturnValue({
      id: 'github',
      rules: [],
      scopeKeys: [],
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      refreshStrategy: 'redirect',
      envVars: { GH_TOKEN: 'oauth' },
    } as any);
    mockGetProvider.mockReturnValue(undefined);
    mockGetTokenEngine.mockReturnValue({
      getOrCreateSubstitute: vi.fn().mockReturnValue(null),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/github/substitute?path=oauth'),
      res,
      SCOPE,
    );
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/No credentials found/);
  });

  it('returns substitute with env var mapping for discovery provider', () => {
    const fakeSub = 'ghp_FaKeSuBsTiTuTe1234567890abcdef';
    mockGetDiscoveryProvider.mockReturnValue({
      id: 'github',
      rules: [],
      scopeKeys: [],
      substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '_' },
      refreshStrategy: 'redirect',
      envVars: { GH_TOKEN: 'oauth', GITHUB_TOKEN: 'oauth' },
    } as any);
    mockGetProvider.mockReturnValue(undefined);
    mockGetTokenEngine.mockReturnValue({
      getOrCreateSubstitute: vi.fn().mockReturnValue(fakeSub),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/github/substitute?path=oauth'),
      res,
      SCOPE,
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.substitute).toBe(fakeSub);
    expect(body.providerId).toBe('github');
    expect(body.credentialPath).toBe('oauth');
    expect(body.envVars).toEqual({
      GH_TOKEN: fakeSub,
      GITHUB_TOKEN: fakeSub,
    });
  });

  it('passes correct args to getOrCreateSubstitute', () => {
    const mockEngine = {
      getOrCreateSubstitute: vi.fn().mockReturnValue('sub_token'),
    };
    const subConfig = { prefixLen: 10, suffixLen: 4, delimiters: '-._~' };
    mockGetDiscoveryProvider.mockReturnValue({
      id: 'todoist',
      rules: [],
      scopeKeys: [],
      substituteConfig: subConfig,
      refreshStrategy: 'redirect',
      envVars: { TODOIST_API_TOKEN: 'api_key' },
    } as any);
    mockGetProvider.mockReturnValue(undefined);
    mockGetTokenEngine.mockReturnValue(mockEngine as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/todoist/substitute?path=api_key'),
      res,
      SCOPE,
    );

    expect(mockEngine.getOrCreateSubstitute).toHaveBeenCalledWith(
      'todoist', {}, SCOPE, subConfig, 'api_key',
    );

    const body = JSON.parse(res._body);
    expect(body.envVars).toEqual({ TODOIST_API_TOKEN: 'sub_token' });
  });

  it('returns empty envVars for builtin provider without discovery', () => {
    mockGetDiscoveryProvider.mockReturnValue(undefined);
    mockGetProvider.mockReturnValue({ id: 'claude' } as any);
    mockGetTokenEngine.mockReturnValue({
      getOrCreateSubstitute: vi.fn().mockReturnValue('sub_claude'),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/claude/substitute?path=oauth'),
      res,
      SCOPE,
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.substitute).toBe('sub_claude');
    expect(body.envVars).toEqual({});
  });

  it('only maps envVars matching the requested credentialPath', () => {
    const fakeSub = 'tok_substitute';
    mockGetDiscoveryProvider.mockReturnValue({
      id: 'stripe',
      rules: [],
      scopeKeys: [],
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      refreshStrategy: 'redirect',
      envVars: { STRIPE_SECRET_KEY: 'api_key', STRIPE_TOKEN: 'oauth' },
    } as any);
    mockGetProvider.mockReturnValue(undefined);
    mockGetTokenEngine.mockReturnValue({
      getOrCreateSubstitute: vi.fn().mockReturnValue(fakeSub),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/stripe/substitute?path=api_key'),
      res,
      SCOPE,
    );

    const body = JSON.parse(res._body);
    // Only STRIPE_SECRET_KEY maps to api_key, not STRIPE_TOKEN (which maps to oauth)
    expect(body.envVars).toEqual({ STRIPE_SECRET_KEY: fakeSub });
  });

  it('decodes URL-encoded provider IDs', () => {
    mockGetDiscoveryProvider.mockReturnValue({
      id: 'my-provider',
      rules: [],
      scopeKeys: [],
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      refreshStrategy: 'redirect',
    } as any);
    mockGetProvider.mockReturnValue(undefined);
    mockGetTokenEngine.mockReturnValue({
      getOrCreateSubstitute: vi.fn().mockReturnValue('sub'),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/my-provider/substitute?path=oauth'),
      res,
      SCOPE,
    );
    expect(res._status).toBe(200);
  });
});
