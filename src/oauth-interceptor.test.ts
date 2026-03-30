import { describe, it, expect } from 'vitest';
import { replaceJsonStringValue } from './oauth-interceptor.js';

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
