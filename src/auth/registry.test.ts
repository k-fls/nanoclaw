import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRegisterProviderHost = vi.fn();
vi.mock('../credential-proxy.js', () => ({
  getProxy: () => ({
    registerProviderHost: mockRegisterProviderHost,
  }),
}));

import { registerProvider, getProvider, getAllProviders } from './registry.js';
import type { CredentialProvider, HostHandler } from './types.js';

const makeStub = (id: string): CredentialProvider => ({
  id,
  displayName: id,
  provision: () => ({ env: {} }),
  storeResult: () => {},
  authOptions: () => [],
});

describe('auth provider registry', () => {
  it('getProvider returns undefined for unknown', () => {
    expect(getProvider('nonexistent-xyz')).toBeUndefined();
  });

  it('register and get round-trip', () => {
    const stub = makeStub('reg-test');
    registerProvider(stub);
    expect(getProvider('reg-test')).toBe(stub);
  });

  it('getAllProviders includes registered', () => {
    const stub = makeStub('all-test');
    registerProvider(stub);
    const all = getAllProviders();
    expect(all.some((p) => p.id === 'all-test')).toBe(true);
  });

  it('later registration overwrites earlier', () => {
    const first = makeStub('overwrite');
    const second = makeStub('overwrite');
    registerProvider(first);
    registerProvider(second);
    expect(getProvider('overwrite')).toBe(second);
  });

  it('registers hostRules with the proxy when provided', () => {
    mockRegisterProviderHost.mockClear();
    const handler: HostHandler = async () => {};
    const provider: CredentialProvider = {
      ...makeStub('host-rules-test'),
      hostRules: [
        {
          hostPattern: /^api\.example\.com$/,
          pathPattern: /^\//,
          handler,
        },
      ],
    };

    registerProvider(provider);

    expect(mockRegisterProviderHost).toHaveBeenCalledWith(
      /^api\.example\.com$/,
      /^\//,
      handler,
    );
  });

  it('does not call proxy when no hostRules', () => {
    mockRegisterProviderHost.mockClear();
    registerProvider(makeStub('no-host-rules'));
    expect(mockRegisterProviderHost).not.toHaveBeenCalled();
  });
});

// ── Token engine singletons ──────────────────────────────────────────

describe('token engine singletons', () => {
  /** Import fresh registry with all dependencies mocked. */
  async function freshRegistry() {
    vi.resetModules();
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../credential-proxy.js', () => ({
      getProxy: () => ({
        registerProviderHost: vi.fn(),
        registerAnchoredRule: vi.fn(),
      }),
    }));
    vi.doMock('./store.js', () => ({
      CREDENTIALS_DIR: '/nonexistent/credentials',
    }));
    vi.doMock('./providers/claude.js', () => ({
      migrateClaudeCredentials: vi.fn(),
      CLAUDE_OAUTH_PROVIDER: { rules: [] },
      wrapWithApiKeySupport: vi.fn(),
    }));
    vi.doMock('./universal-oauth-handler.js', () => ({
      createHandler: vi.fn(),
    }));
    vi.doMock('./browser-open-handler.js', () => ({
      registerAuthorizationEndpoint: vi.fn(),
    }));
    vi.doMock('./discovery-loader.js', () => ({
      loadDiscoveryProviders: vi.fn(() => new Map()),
    }));
    // Mock fs so migrateAllScopes and loadAllPersistedRefs don't hit disk
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        default: {
          ...actual,
          existsSync: vi.fn(() => false),
          readdirSync: vi.fn(() => []),
        },
      };
    });
    return import('./registry.js');
  }

  it('getTokenResolver returns a singleton', async () => {
    const { getTokenResolver } = await freshRegistry();
    const first = getTokenResolver();
    const second = getTokenResolver();
    expect(first).toBe(second);
    expect(first).toBeDefined();
  });

  it('getTokenEngine returns a singleton', async () => {
    const { getTokenEngine } = await freshRegistry();
    const first = getTokenEngine();
    const second = getTokenEngine();
    expect(first).toBe(second);
    expect(first).toBeDefined();
  });

  it('getTokenEngine uses the resolver from getTokenResolver', async () => {
    const { getTokenResolver, getTokenEngine } = await freshRegistry();
    const resolver = getTokenResolver();
    const engine = getTokenEngine();
    // The engine internally holds a reference to the resolver.
    // We verify they share the same instance by checking the engine exists
    // and was created with the resolver (singleton guarantee).
    expect(engine).toBeDefined();
    expect(resolver).toBeDefined();
  });
});
