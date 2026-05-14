import { describe, it, expect } from 'vitest';
import { parseBody, replaceJsonStringValue } from './oauth-interceptor.js';

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

describe('parseBody', () => {
  it('returns null for unparseable input', () => {
    expect(parseBody('')).toBeNull();
    expect(parseBody('hello world')).toBeNull();
    expect(parseBody('{invalid json')).toBeNull();
  });

  describe('JSON format', () => {
    it('parses fields', () => {
      const body = parseBody(
        '{"access_token":"abc","token_type":"bearer","expires_in":3600}',
      );
      expect(body).not.toBeNull();
      expect(body!.fields.access_token).toBe('abc');
      expect(body!.fields.token_type).toBe('bearer');
      expect(body!.fields.expires_in).toBe('3600');
    });

    it('set() preserves other fields byte-for-byte', () => {
      const raw = '{"access_token": "old", "scope": "email"}';
      const body = parseBody(raw)!;
      body.set('access_token', 'new');
      expect(body.serialize()).toBe(
        '{"access_token": "new", "scope": "email"}',
      );
      expect(body.fields.access_token).toBe('new');
    });

    it('multiple set() calls work', () => {
      const body = parseBody(
        '{"access_token":"a","refresh_token":"r","scope":"s"}',
      )!;
      body.set('access_token', 'a2');
      body.set('refresh_token', 'r2');
      expect(body.serialize()).toBe(
        '{"access_token":"a2","refresh_token":"r2","scope":"s"}',
      );
    });
  });

  describe('form-encoded format', () => {
    it('parses fields', () => {
      const body = parseBody(
        'access_token=gho_abc&token_type=bearer&scope=repo%2Cuser',
      );
      expect(body).not.toBeNull();
      expect(body!.fields.access_token).toBe('gho_abc');
      expect(body!.fields.token_type).toBe('bearer');
      expect(body!.fields.scope).toBe('repo,user');
    });

    it('set() preserves field order', () => {
      const body = parseBody('access_token=old&token_type=bearer&scope=repo')!;
      body.set('access_token', 'new');
      const result = body.serialize();
      // access_token should still come first
      expect(result).toMatch(/^access_token=new&/);
      expect(result).toContain('token_type=bearer');
      expect(result).toContain('scope=repo');
    });

    it('handles URL-encoded special characters', () => {
      const body = parseBody('key=a%3Db%26c&other=hello%20world')!;
      expect(body.fields.key).toBe('a=b&c');
      expect(body.fields.other).toBe('hello world');
    });

    it('round-trips through set()', () => {
      const raw = 'access_token=gho_real&token_type=bearer&scope=repo';
      const body = parseBody(raw)!;
      body.set('access_token', 'sub_001');
      const result = body.serialize();
      const reparsed = parseBody(result)!;
      expect(reparsed.fields.access_token).toBe('sub_001');
      expect(reparsed.fields.token_type).toBe('bearer');
      expect(reparsed.fields.scope).toBe('repo');
    });
  });
});
