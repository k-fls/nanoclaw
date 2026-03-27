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

import {
  registerProvider,
  getProvider,
  getAllProviders,
} from './registry.js';
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
