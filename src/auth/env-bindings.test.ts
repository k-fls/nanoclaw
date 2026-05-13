import { describe, it, expect } from 'vitest';
import type { OAuthProvider } from './oauth-types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from './oauth-types.js';
import {
  parseEnvVarValue,
  distinctCredentialPaths,
  bindingsFor,
  materializeEnv,
  groupEnvEntries,
} from './env-bindings.js';

function makeProvider(overrides: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: 'test',
    rules: [],
    scopeKeys: [],
    substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
    refreshStrategy: 'redirect',
    ...overrides,
  };
}

describe('parseEnvVarValue', () => {
  it('parses plain credential path', () => {
    expect(parseEnvVarValue('GH_TOKEN', 'oauth')).toEqual({
      envName: 'GH_TOKEN',
      credentialPath: 'oauth',
    });
  });

  it('parses slice syntax', () => {
    expect(parseEnvVarValue('BS_USER', 'access_key[0]')).toEqual({
      envName: 'BS_USER',
      credentialPath: 'access_key',
      slice: 0,
    });
  });

  it('rejects malformed values', () => {
    expect(parseEnvVarValue('X', '')).toBeNull();
    expect(parseEnvVarValue('X', 'a[b]')).toBeNull();
    expect(parseEnvVarValue('X', '[0]')).toBeNull();
  });
});

describe('distinctCredentialPaths', () => {
  it('dedupes composite credentials', () => {
    const provider = makeProvider({
      envBindings: [
        { envName: 'USER', credentialPath: 'access_key', slice: 0 },
        { envName: 'KEY', credentialPath: 'access_key', slice: 1 },
        { envName: 'OTHER', credentialPath: 'oauth' },
      ],
    });
    expect(distinctCredentialPaths(provider).sort()).toEqual([
      'access_key',
      'oauth',
    ]);
  });

  it('excludes nested credential paths', () => {
    const provider = makeProvider({
      envBindings: [
        { envName: 'A', credentialPath: 'oauth' },
        { envName: 'B', credentialPath: 'oauth/refresh' },
      ],
    });
    expect(distinctCredentialPaths(provider)).toEqual(['oauth']);
  });
});

describe('bindingsFor', () => {
  it('returns bindings matching a credential path in order', () => {
    const provider = makeProvider({
      envBindings: [
        { envName: 'USER', credentialPath: 'access_key', slice: 0 },
        { envName: 'KEY', credentialPath: 'access_key', slice: 1 },
        { envName: 'OTHER', credentialPath: 'oauth' },
      ],
    });
    const result = bindingsFor(provider, 'access_key');
    expect(result.map((b) => b.envName)).toEqual(['USER', 'KEY']);
  });
});

describe('materializeEnv', () => {
  it('returns substitute as-is for plain bindings', () => {
    expect(
      materializeEnv({ envName: 'X', credentialPath: 'oauth' }, 'sub_token', {}),
    ).toBe('sub_token');
  });

  it('slices substitute by sep', () => {
    expect(
      materializeEnv(
        { envName: 'X', credentialPath: 'a', slice: 1 },
        'aaa:bbb:ccc',
        { sep: ':' },
      ),
    ).toBe('bbb');
  });

  it('returns null when slice index out of bounds', () => {
    expect(
      materializeEnv(
        { envName: 'X', credentialPath: 'a', slice: 5 },
        'a:b',
        { sep: ':' },
      ),
    ).toBeNull();
  });

  it('returns null when sliced binding has no sep declared', () => {
    expect(
      materializeEnv(
        { envName: 'X', credentialPath: 'a', slice: 0 },
        'a:b',
        {},
      ),
    ).toBeNull();
  });
});

describe('groupEnvEntries', () => {
  const browserstack = makeProvider({
    id: 'browserstack',
    envBindings: [
      { envName: 'BROWSERSTACK_USERNAME', credentialPath: 'access_key', slice: 0 },
      { envName: 'BROWSERSTACK_ACCESS_KEY', credentialPath: 'access_key', slice: 1 },
    ],
    credentialFormat: { access_key: { encode: 'base64', sep: ':' } },
  });

  it('joins composite credential from slice bindings in declared order', () => {
    const entries = new Map([
      ['BROWSERSTACK_USERNAME', 'kirill'],
      ['BROWSERSTACK_ACCESS_KEY', 'sk_abc123'],
    ]);
    const { resolved, warnings } = groupEnvEntries(browserstack, entries);
    expect(warnings).toEqual([]);
    expect(resolved.get('access_key')?.value).toBe('kirill:sk_abc123');
    expect(resolved.get('access_key')?.sourceEnvNames).toEqual([
      'BROWSERSTACK_USERNAME',
      'BROWSERSTACK_ACCESS_KEY',
    ]);
  });

  it('joins in declared order regardless of map iteration order', () => {
    const entries = new Map([
      ['BROWSERSTACK_ACCESS_KEY', 'sk_abc'],
      ['BROWSERSTACK_USERNAME', 'kirill'],
    ]);
    const { resolved } = groupEnvEntries(browserstack, entries);
    expect(resolved.get('access_key')?.value).toBe('kirill:sk_abc');
  });

  it('warns when composite is incomplete', () => {
    const entries = new Map([['BROWSERSTACK_USERNAME', 'kirill']]);
    const { resolved, warnings } = groupEnvEntries(browserstack, entries);
    expect(resolved.has('access_key')).toBe(false);
    expect(warnings.some((w) => w.includes('BROWSERSTACK_ACCESS_KEY'))).toBe(true);
  });

  it('passes through unknown env names as credential IDs', () => {
    const provider = makeProvider({ envBindings: [] });
    const entries = new Map([['CUSTOM_KEY', 'val']]);
    const { resolved } = groupEnvEntries(provider, entries);
    expect(resolved.get('CUSTOM_KEY')?.value).toBe('val');
  });

  it('warns on missing sep for composite', () => {
    const provider = makeProvider({
      envBindings: [
        { envName: 'A', credentialPath: 'composite', slice: 0 },
        { envName: 'B', credentialPath: 'composite', slice: 1 },
      ],
    });
    const entries = new Map([
      ['A', 'x'],
      ['B', 'y'],
    ]);
    const { resolved, warnings } = groupEnvEntries(provider, entries);
    expect(resolved.has('composite')).toBe(false);
    expect(warnings.some((w) => w.includes('sep'))).toBe(true);
  });
});
