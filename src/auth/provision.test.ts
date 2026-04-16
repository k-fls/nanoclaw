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
const {
  importEnvToMainGroup,
  importEnvCredentials,
  provisionFromMapping,
  createAccessCheck,
  provisionEnvVars,
} = await import('./provision.js');
const { readEnvFile } = await import('../env.js');

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
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
      importEnv: importEnvMock,
    };
    registerProvider(provider);

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    importEnvToMainGroup(engine, asCredentialScope('main'));
    expect(importEnvMock).toHaveBeenCalledWith(asCredentialScope('main'), engine);
  });

  it('skips providers without importEnv', () => {
    const provider: CredentialProvider = {
      id: 'test-no-import',
      displayName: 'Test',
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    // Should not throw
    importEnvToMainGroup(engine, asCredentialScope('main'));
  });
});

// ---------------------------------------------------------------------------
// importEnvCredentials
// ---------------------------------------------------------------------------

describe('importEnvCredentials', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('imports env vars into credential store by mapping', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      MY_TOKEN: 'tok_abcdefghijklmnopqrstuvwxyz12345678',
    });

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const scope = asCredentialScope('import-test');
    const imported = importEnvCredentials(
      { MY_TOKEN: 'oauth' },
      'test-prov',
      scope,
      engine,
    );

    expect(imported).toEqual(new Set(['oauth']));
    const cred = engine.resolveCredential(asGroupScope('import-test'), 'test-prov', 'oauth');
    expect(cred?.value).toBe('tok_abcdefghijklmnopqrstuvwxyz12345678');
  });

  it('skips when substitute already exists', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const scope = asCredentialScope('skip-test');
    const realToken = 'tok_abcdefghijklmnopqrstuvwxyz12345678';

    // Pre-store and generate substitute
    engine.storeCredential('test-prov', scope, 'oauth', {
      value: realToken,
      expires_ts: 0,
      updated_ts: Date.now(),
    });
    engine.generateSubstitute(
      realToken, 'test-prov', {}, asGroupScope('skip-test'),
      DEFAULT_SUBSTITUTE_CONFIG, 'oauth',
    );

    vi.mocked(readEnvFile).mockReturnValueOnce({
      MY_TOKEN: 'tok_should_not_overwrite_xxxxxxxxxxxx',
    });

    const imported = importEnvCredentials(
      { MY_TOKEN: 'oauth' },
      'test-prov',
      scope,
      engine,
    );

    expect(imported).toEqual(new Set());
  });

  it('first env var wins when multiple map to same credentialPath', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      PRIMARY: 'tok_primary_xxxxxxxxxxxxxxxxxxxxxxxx',
      FALLBACK: 'tok_fallback_xxxxxxxxxxxxxxxxxxxxxx',
    });

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const scope = asCredentialScope('alias-test');
    const imported = importEnvCredentials(
      { PRIMARY: 'oauth', FALLBACK: 'oauth' },
      'test-prov',
      scope,
      engine,
    );

    expect(imported).toEqual(new Set(['oauth']));
    const cred = engine.resolveCredential(asGroupScope('alias-test'), 'test-prov', 'oauth');
    expect(cred?.value).toBe('tok_primary_xxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('uses custom buildCredential callback', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      MY_TOKEN: 'tok_custom_xxxxxxxxxxxxxxxxxxxxxxxxx',
    });

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const scope = asCredentialScope('custom-test');
    importEnvCredentials(
      { MY_TOKEN: 'oauth' },
      'test-prov',
      scope,
      engine,
      (value, _path) => ({
        value,
        expires_ts: 0,
        updated_ts: Date.now(),
        authFields: { client_id: 'test-client' },
      }),
    );

    const cred = engine.resolveCredential(asGroupScope('custom-test'), 'test-prov', 'oauth');
    expect(cred?.authFields).toEqual({ client_id: 'test-client' });
  });

  it('returns empty set when no env vars match', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({});

    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const imported = importEnvCredentials(
      { MISSING: 'oauth' },
      'test-prov',
      asCredentialScope('empty-test'),
      engine,
    );

    expect(imported).toEqual(new Set());
  });

  it('returns empty set for empty mapping', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const imported = importEnvCredentials(
      {},
      'test-prov',
      asCredentialScope('empty-map'),
      engine,
    );
    expect(imported).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// provisionFromMapping
// ---------------------------------------------------------------------------

describe('provisionFromMapping', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('produces env vars from stored credentials', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const realToken = 'gho_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';

    engine.storeCredential('test-prov', asCredentialScope('prov-test'), CRED_OAUTH, {
      value: realToken,
      expires_ts: 0,
      updated_ts: Date.now(),
    });

    const env = provisionFromMapping(
      { GH_TOKEN: CRED_OAUTH },
      'test-prov',
      asGroupScope('prov-test'),
      DEFAULT_SUBSTITUTE_CONFIG,
      engine,
    );

    expect(env.GH_TOKEN).toBeDefined();
    expect(env.GH_TOKEN).not.toBe(realToken);
    expect(env.GH_TOKEN.length).toBe(realToken.length);
  });

  it('multiple env vars for same credential get same substitute', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const realToken = 'gho_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijk';

    engine.storeCredential('test-prov', asCredentialScope('multi-test'), CRED_OAUTH, {
      value: realToken,
      expires_ts: 0,
      updated_ts: Date.now(),
    });

    const env = provisionFromMapping(
      { GH_TOKEN: CRED_OAUTH, GITHUB_TOKEN: CRED_OAUTH },
      'test-prov',
      asGroupScope('multi-test'),
      DEFAULT_SUBSTITUTE_CONFIG,
      engine,
    );

    expect(env.GH_TOKEN).toBe(env.GITHUB_TOKEN);
  });

  it('skips env var when no credential exists', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const env = provisionFromMapping(
      { GH_TOKEN: CRED_OAUTH },
      'test-prov',
      asGroupScope('missing-test'),
      DEFAULT_SUBSTITUTE_CONFIG,
      engine,
    );

    expect(env).toEqual({});
  });

  it('returns empty for empty mapping', () => {
    const engine = new TokenSubstituteEngine(new PersistentCredentialResolver());
    const env = provisionFromMapping(
      {},
      'test-prov',
      asGroupScope('empty-map'),
      DEFAULT_SUBSTITUTE_CONFIG,
      engine,
    );
    expect(env).toEqual({});
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
