import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Temp dir for credential store
const tmpDir = path.join(os.tmpdir(), `nanoclaw-provision-test-${Date.now()}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env.ts to control .env content
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const { initCredentialStore } = await import('./store.js');
const { registerProvider } = await import('./registry.js');
const { importEnvToMainGroup, createAccessCheck, provisionEnvVars } =
  await import('./provision.js');

import type { CredentialProvider } from './types.js';
import type { RegisteredGroup } from '../types.js';
import type { OAuthProvider } from './oauth-types.js';
import {
  asGroupScope,
  asCredentialScope,
  DEFAULT_SUBSTITUTE_CONFIG,
  CRED_OAUTH,
} from './oauth-types.js';
import {
  TokenSubstituteEngine,
  PersistentCredentialResolver,
} from './token-substitute.js';

function makeGroup(
  folder: string,
  opts?: {
    credentialSource?: string;
    credentialGrantees?: string[];
    isMain?: boolean;
  },
): RegisteredGroup {
  return {
    name: `Group ${folder}`,
    folder,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    containerConfig:
      opts?.credentialSource || opts?.credentialGrantees
        ? {
            credentialSource: opts.credentialSource,
            credentialGrantees: opts.credentialGrantees
              ? new Set(opts.credentialGrantees)
              : undefined,
          }
        : undefined,
    isMain: opts?.isMain,
  };
}

describe('createAccessCheck', () => {
  const groups = new Map<string, RegisteredGroup>();
  const resolver = (folder: string) => groups.get(folder);
  const check = createAccessCheck(resolver);

  beforeEach(() => {
    groups.clear();
  });

  it('allows own scope', () => {
    groups.set('self', makeGroup('self'));
    expect(check(asGroupScope('self'), asCredentialScope('self'))).toBe(true);
  });

  it('allows bilateral grant (both sides configured)', () => {
    groups.set(
      'borrower',
      makeGroup('borrower', { credentialSource: 'grantor' }),
    );
    groups.set(
      'grantor',
      makeGroup('grantor', { credentialGrantees: ['borrower'] }),
    );
    expect(
      check(asGroupScope('borrower'), asCredentialScope('grantor')),
    ).toBe(true);
  });

  it('denies when borrower claims source but grantor has not granted', () => {
    groups.set(
      'borrower',
      makeGroup('borrower', { credentialSource: 'grantor' }),
    );
    groups.set('grantor', makeGroup('grantor'));
    expect(
      check(asGroupScope('borrower'), asCredentialScope('grantor')),
    ).toBe(false);
  });

  it('denies when grantor has granted but borrower has not set source', () => {
    groups.set('borrower', makeGroup('borrower'));
    groups.set(
      'grantor',
      makeGroup('grantor', { credentialGrantees: ['borrower'] }),
    );
    expect(
      check(asGroupScope('borrower'), asCredentialScope('grantor')),
    ).toBe(false);
  });

  it('denies cross-group access without any sharing', () => {
    groups.set('group-a', makeGroup('group-a'));
    groups.set('group-b', makeGroup('group-b'));
    expect(check(asGroupScope('group-a'), asCredentialScope('group-b'))).toBe(
      false,
    );
  });

  it('denies for unknown borrower group', () => {
    expect(
      check(asGroupScope('nonexistent'), asCredentialScope('grantor')),
    ).toBe(false);
  });

  it('denies for unknown grantor group', () => {
    groups.set(
      'borrower',
      makeGroup('borrower', { credentialSource: 'nonexistent' }),
    );
    expect(
      check(asGroupScope('borrower'), asCredentialScope('nonexistent')),
    ).toBe(false);
  });
});

describe('importEnvToMainGroup', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('calls importEnv on providers that have it', () => {
    const importEnvMock = vi.fn();
    const provider: CredentialProvider = {
      id: 'test-import',
      displayName: 'Test',
      credentialPaths: ['oauth'],
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
      importEnv: importEnvMock,
    };
    registerProvider(provider);

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    importEnvToMainGroup(engine, 'main');
    expect(importEnvMock).toHaveBeenCalledWith('main', expect.anything());
  });

  it('skips providers without importEnv', () => {
    const provider: CredentialProvider = {
      id: 'test-no-import',
      displayName: 'Test',
      credentialPaths: ['oauth'],
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    // Should not throw
    importEnvToMainGroup(engine, 'main');
  });
});

// ---------------------------------------------------------------------------
// provisionEnvVars
// ---------------------------------------------------------------------------

function makeOAuthProvider(envVars?: Record<string, string>): OAuthProvider {
  return {
    id: 'test-provider',
    rules: [],
    scopeKeys: [],
    substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
    refreshStrategy: 'redirect',
    envVars,
  };
}

describe('provisionEnvVars', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('provisions oauth token as env var', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const provider = makeOAuthProvider({ GH_TOKEN: CRED_OAUTH });
    const realToken = 'gho_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';

    engine.generateSubstitute(
      realToken,
      'test-provider',
      {},
      asGroupScope('my-group'),
      DEFAULT_SUBSTITUTE_CONFIG,
      CRED_OAUTH,
    );

    const env = provisionEnvVars(provider, makeGroup('my-group'), engine);
    expect(env.GH_TOKEN).toBeDefined();
    expect(env.GH_TOKEN).not.toBe(realToken);
    expect(env.GH_TOKEN.length).toBe(realToken.length);
  });

  it('provisions multiple env vars for the same credential', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const provider = makeOAuthProvider({
      GH_TOKEN: CRED_OAUTH,
      GITHUB_TOKEN: CRED_OAUTH,
    });
    const realToken = 'gho_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';

    engine.generateSubstitute(
      realToken,
      'test-provider',
      {},
      asGroupScope('my-group'),
      DEFAULT_SUBSTITUTE_CONFIG,
      CRED_OAUTH,
    );

    const env = provisionEnvVars(provider, makeGroup('my-group'), engine);
    expect(env.GH_TOKEN).toBeDefined();
    expect(env.GITHUB_TOKEN).toBeDefined();
    // Both should resolve to the same substitute
    expect(env.GH_TOKEN).toBe(env.GITHUB_TOKEN);
  });

  it('skips env var when no token exists for the credential', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const provider = makeOAuthProvider({ GH_TOKEN: CRED_OAUTH });

    // No tokens stored
    const env = provisionEnvVars(provider, makeGroup('empty-group'), engine);
    expect(env).toEqual({});
  });

  it('returns empty when provider has no envVars mapping', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const provider = makeOAuthProvider(); // no envVars

    const env = provisionEnvVars(provider, makeGroup('my-group'), engine);
    expect(env).toEqual({});
  });

  it('provisions api_key role', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const provider = makeOAuthProvider({ API_KEY: 'api_key' });
    const realKey = 'key_xabcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';

    engine.generateSubstitute(
      realKey,
      'test-provider',
      {},
      asGroupScope('my-group'),
      DEFAULT_SUBSTITUTE_CONFIG,
      'api_key',
    );

    const env = provisionEnvVars(provider, makeGroup('my-group'), engine);
    expect(env.API_KEY).toBeDefined();
    expect(env.API_KEY).not.toBe(realKey);
  });
});
