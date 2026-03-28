import { describe, it, expect } from 'vitest';
import {
  replaceJsonStringValue,
  detectMode,
  OAuthProviderConfig,
} from './oauth-interceptor.js';

describe('replaceJsonStringValue', () => {
  it('replaces a token value preserving field order and whitespace', () => {
    const json =
      '{"access_token": "real-abc", "token_type": "Bearer", "refresh_token": "real-xyz", "expires_in": 3600}';
    const result = replaceJsonStringValue(json, 'access_token', 'sub-001');
    expect(result).toBe(
      '{"access_token": "sub-001", "token_type": "Bearer", "refresh_token": "real-xyz", "expires_in": 3600}',
    );
  });

  it('replaces refresh_token without touching access_token', () => {
    const json = '{"access_token":"aaa","refresh_token":"bbb"}';
    const result = replaceJsonStringValue(json, 'refresh_token', 'ccc');
    expect(result).toBe('{"access_token":"aaa","refresh_token":"ccc"}');
  });

  it('handles escaped characters in existing value', () => {
    const json = '{"access_token":"has\\"quotes","other":"x"}';
    const result = replaceJsonStringValue(json, 'access_token', 'clean');
    expect(result).toBe('{"access_token":"clean","other":"x"}');
  });

  it('escapes special characters in new value', () => {
    const json = '{"access_token":"old","other":"x"}';
    const result = replaceJsonStringValue(
      json,
      'access_token',
      'has"quotes\nand\tnewlines',
    );
    expect(result).toContain('"has\\"quotes\\nand\\tnewlines"');
    // Parse to verify it's valid JSON
    const parsed = JSON.parse(result);
    expect(parsed.access_token).toBe('has"quotes\nand\tnewlines');
    expect(parsed.other).toBe('x');
  });

  it('preserves pretty-printed JSON formatting', () => {
    const json = '{\n  "access_token": "old",\n  "scope": "email"\n}';
    const result = replaceJsonStringValue(json, 'access_token', 'new');
    expect(result).toBe('{\n  "access_token": "new",\n  "scope": "email"\n}');
  });

  it('returns original if key not found', () => {
    const json = '{"other":"value"}';
    const result = replaceJsonStringValue(json, 'access_token', 'new');
    expect(result).toBe(json);
  });

  it('handles multiple replacements on same string', () => {
    const json = '{"access_token":"a1","refresh_token":"r1","expires_in":3600}';
    let result = replaceJsonStringValue(json, 'access_token', 'a2');
    result = replaceJsonStringValue(result, 'refresh_token', 'r2');
    expect(result).toBe(
      '{"access_token":"a2","refresh_token":"r2","expires_in":3600}',
    );
  });
});

describe('detectMode', () => {
  const provider: OAuthProviderConfig = {
    id: 'google',
    tokenEndpoint: /^oauth2\.googleapis\.com\/token$/,
    authorizeEndpoint: /^accounts\.google\.com\/o\/oauth2\/v2\/auth/,
    protectedUrls: /^(www\.googleapis\.com|sheets\.googleapis\.com)\//,
    callbacks: {} as any,
  };

  it('detects token-exchange for token endpoint', () => {
    const result = detectMode('oauth2.googleapis.com', '/token', [provider]);
    expect(result).toEqual({ mode: 'token-exchange', provider });
  });

  it('detects authorize-stub for authorize endpoint', () => {
    const result = detectMode(
      'accounts.google.com',
      '/o/oauth2/v2/auth?client_id=x',
      [provider],
    );
    expect(result).toEqual({ mode: 'authorize-stub', provider });
  });

  it('detects bearer-swap for protected API', () => {
    const result = detectMode('www.googleapis.com', '/drive/v3/files', [
      provider,
    ]);
    expect(result).toEqual({ mode: 'bearer-swap', provider });
  });

  it('returns null for unmatched host', () => {
    const result = detectMode('example.com', '/anything', [provider]);
    expect(result).toBeNull();
  });

  it('prefers token-exchange over bearer-swap on same host', () => {
    // Provider where token endpoint and API are on the same host
    const githubProvider: OAuthProviderConfig = {
      id: 'github',
      tokenEndpoint: /^github\.com\/login\/oauth\/access_token$/,
      authorizeEndpoint: /^github\.com\/login\/oauth\/authorize/,
      protectedUrls: /^github\.com\/api\//,
      callbacks: {} as any,
    };
    const result = detectMode('github.com', '/login/oauth/access_token', [
      githubProvider,
    ]);
    expect(result).toEqual({
      mode: 'token-exchange',
      provider: githubProvider,
    });
  });
});
