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

function setupGithubProvider(
  mockEngine?: Record<string, any>,
) {
  mockGetDiscoveryProvider.mockReturnValue({
    id: 'github',
    rules: [],
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '_' },
    refreshStrategy: 'redirect',
    envVars: { GH_TOKEN: 'oauth', GITHUB_TOKEN: 'oauth' },
  } as any);
  mockGetProvider.mockReturnValue(undefined);
  mockGetTokenEngine.mockReturnValue(
    (mockEngine ?? {
      getOrCreateSubstitute: vi.fn().mockReturnValue('ghp_FaKeSuBsTiTuTe1234567890abcdef'),
      mergeEnvNames: vi.fn(),
    }) as any,
  );
}

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

  it('returns substitute with envNames for discovery provider', () => {
    setupGithubProvider();

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/github/substitute?path=oauth'),
      res,
      SCOPE,
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.substitute).toBe('ghp_FaKeSuBsTiTuTe1234567890abcdef');
    expect(body.providerId).toBe('github');
    expect(body.credentialPath).toBe('oauth');
    expect(body.envNames).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
  });

  it('passes envNames to getOrCreateSubstitute', () => {
    const mockEngine = {
      getOrCreateSubstitute: vi.fn().mockReturnValue('sub_token'),
      mergeEnvNames: vi.fn(),
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
      ['TODOIST_API_TOKEN'],
    );

    const body = JSON.parse(res._body);
    expect(body.envNames).toEqual(['TODOIST_API_TOKEN']);
  });

  it('returns empty envNames for builtin provider without discovery', () => {
    mockGetDiscoveryProvider.mockReturnValue(undefined);
    mockGetProvider.mockReturnValue({ id: 'claude' } as any);
    mockGetTokenEngine.mockReturnValue({
      getOrCreateSubstitute: vi.fn().mockReturnValue('sub_claude'),
      mergeEnvNames: vi.fn(),
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
    expect(body.envNames).toEqual([]);
  });

  it('only maps envNames matching the requested credentialPath', () => {
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
      mergeEnvNames: vi.fn(),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/stripe/substitute?path=api_key'),
      res,
      SCOPE,
    );

    const body = JSON.parse(res._body);
    // Only STRIPE_SECRET_KEY maps to api_key, not STRIPE_TOKEN (which maps to oauth)
    expect(body.envNames).toEqual(['STRIPE_SECRET_KEY']);
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
      mergeEnvNames: vi.fn(),
    } as any);

    const res = mockResponse();
    handleSubstituteRequest(
      mockRequest('/credentials/my-provider/substitute?path=oauth'),
      res,
      SCOPE,
    );
    expect(res._status).toBe(200);
  });

  // ── envVar parameter tests ──────────────────────────────────────────

  describe('envVar parameter', () => {
    it('rejects invalid envVar format (lowercase)', () => {
      setupGithubProvider();

      const res = mockResponse();
      handleSubstituteRequest(
        mockRequest('/credentials/github/substitute?path=oauth&envVar=my_token'),
        res,
        SCOPE,
      );
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Invalid env var name format/);
    });

    it('rejects reserved Docker env var names', () => {
      setupGithubProvider();

      const res = mockResponse();
      handleSubstituteRequest(
        mockRequest('/credentials/github/substitute?path=oauth&envVar=PROXY_HOST'),
        res,
        SCOPE,
      );
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Reserved env var name/);
    });

    it('rejects dangerous system env var names', () => {
      setupGithubProvider();

      for (const name of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS']) {
        const res = mockResponse();
        handleSubstituteRequest(
          mockRequest(`/credentials/github/substitute?path=oauth&envVar=${name}`),
          res,
          SCOPE,
        );
        expect(res._status).toBe(400);
        expect(JSON.parse(res._body).error).toMatch(/Reserved env var name/);
      }
    });

    it('rejects ANTHROPIC_API_KEY as envVar', () => {
      setupGithubProvider();

      const res = mockResponse();
      handleSubstituteRequest(
        mockRequest('/credentials/github/substitute?path=oauth&envVar=ANTHROPIC_API_KEY'),
        res,
        SCOPE,
      );
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Reserved env var name/);
    });

    it('includes custom envVar in envNames and calls mergeEnvNames', () => {
      const mockEngine = {
        getOrCreateSubstitute: vi.fn().mockReturnValue('ghp_sub123'),
        mergeEnvNames: vi.fn(),
      };
      setupGithubProvider(mockEngine);

      const res = mockResponse();
      handleSubstituteRequest(
        mockRequest('/credentials/github/substitute?path=oauth&envVar=MY_GITHUB'),
        res,
        SCOPE,
      );

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      // envNames includes discovery defaults + custom envVar
      expect(body.envNames).toEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'MY_GITHUB']);

      // mergeEnvNames called to persist custom envVar on existing entry
      expect(mockEngine.mergeEnvNames).toHaveBeenCalledWith(
        SCOPE, 'github', 'ghp_sub123', ['MY_GITHUB'],
      );
    });

    it('deduplicates envVar that already exists in discovery', () => {
      const mockEngine = {
        getOrCreateSubstitute: vi.fn().mockReturnValue('ghp_sub123'),
        mergeEnvNames: vi.fn(),
      };
      setupGithubProvider(mockEngine);

      const res = mockResponse();
      handleSubstituteRequest(
        mockRequest('/credentials/github/substitute?path=oauth&envVar=GH_TOKEN'),
        res,
        SCOPE,
      );

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      // GH_TOKEN already in discovery, should not be duplicated
      expect(body.envNames).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
    });

    it('accepts valid custom envVar names', () => {
      setupGithubProvider();

      for (const name of ['MY_TOKEN', 'CUSTOM_API_KEY', '_PRIVATE', 'A']) {
        const res = mockResponse();
        handleSubstituteRequest(
          mockRequest(`/credentials/github/substitute?path=oauth&envVar=${name}`),
          res,
          SCOPE,
        );
        expect(res._status).toBe(200);
      }
    });

    it('rejects envVar starting with digit', () => {
      setupGithubProvider();

      const res = mockResponse();
      handleSubstituteRequest(
        mockRequest('/credentials/github/substitute?path=oauth&envVar=3INVALID'),
        res,
        SCOPE,
      );
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Invalid env var name format/);
    });
  });
});
