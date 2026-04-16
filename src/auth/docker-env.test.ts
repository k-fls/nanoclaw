import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvCustomJsonl, validateEnvVarName, writeEnvVarsFile } from './docker-env.js';

describe('validateEnvVarName', () => {
  it('accepts valid names', () => {
    expect(validateEnvVarName('MY_VAR')).toBeNull();
    expect(validateEnvVarName('_PRIVATE')).toBeNull();
    expect(validateEnvVarName('A')).toBeNull();
    expect(validateEnvVarName('FOO_BAR_123')).toBeNull();
  });

  it('rejects lowercase', () => {
    expect(validateEnvVarName('my_var')).toMatch(/Invalid/);
  });

  it('rejects names starting with digit', () => {
    expect(validateEnvVarName('3FOO')).toMatch(/Invalid/);
  });

  it('rejects reserved Docker env names', () => {
    expect(validateEnvVarName('PROXY_HOST')).toMatch(/Reserved/);
    expect(validateEnvVarName('ANTHROPIC_API_KEY')).toMatch(/Reserved/);
    expect(validateEnvVarName('BASH_ENV')).toMatch(/Reserved/);
  });

  it('rejects dangerous system vars', () => {
    expect(validateEnvVarName('PATH')).toMatch(/Reserved/);
    expect(validateEnvVarName('LD_PRELOAD')).toMatch(/Reserved/);
    expect(validateEnvVarName('NODE_OPTIONS')).toMatch(/Reserved/);
  });
});

describe('parseEnvCustomJsonl', () => {
  const noClaimed = new Set<string>();

  it('parses valid JSONL entries', () => {
    const content = [
      '{"name":"MY_VAR","value":"hello"}',
      '{"name":"ANOTHER","value":"world"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({
      MY_VAR: 'hello',
      ANOTHER: 'world',
    });
  });

  it('last-write-wins for duplicate names', () => {
    const content = [
      '{"name":"MY_VAR","value":"first"}',
      '{"name":"MY_VAR","value":"second"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({
      MY_VAR: 'second',
    });
  });

  it('stops at first unparsable line', () => {
    const content = [
      '{"name":"GOOD_ONE","value":"ok"}',
      'this is not json',
      '{"name":"AFTER_BAD","value":"lost"}',
    ].join('\n');

    const result = parseEnvCustomJsonl(content, noClaimed);
    expect(result).toEqual({ GOOD_ONE: 'ok' });
    expect(result).not.toHaveProperty('AFTER_BAD');
  });

  it('stops at structurally invalid entry', () => {
    const content = [
      '{"name":"GOOD","value":"ok"}',
      '{"name":123,"value":"bad type"}',
      '{"name":"LOST","value":"gone"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({ GOOD: 'ok' });
  });

  it('stops at entry missing value field', () => {
    const content = [
      '{"name":"GOOD","value":"ok"}',
      '{"name":"NO_VALUE"}',
      '{"name":"LOST","value":"gone"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({ GOOD: 'ok' });
  });

  it('skips reserved env var names', () => {
    const content = [
      '{"name":"PATH","value":"/bad"}',
      '{"name":"PROXY_HOST","value":"evil"}',
      '{"name":"SAFE_VAR","value":"ok"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({
      SAFE_VAR: 'ok',
    });
  });

  it('skips names with invalid format', () => {
    const content = [
      '{"name":"lowercase","value":"bad"}',
      '{"name":"3DIGIT","value":"bad"}',
      '{"name":"VALID","value":"ok"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({
      VALID: 'ok',
    });
  });

  it('excludes names already claimed by credentials', () => {
    const claimed = new Set(['GH_TOKEN', 'SLACK_TOKEN']);
    const content = [
      '{"name":"GH_TOKEN","value":"overridden"}',
      '{"name":"MY_CUSTOM","value":"ok"}',
      '{"name":"SLACK_TOKEN","value":"also overridden"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, claimed)).toEqual({
      MY_CUSTOM: 'ok',
    });
  });

  it('returns empty for empty content', () => {
    expect(parseEnvCustomJsonl('', noClaimed)).toEqual({});
  });

  it('returns empty for entirely unparsable content', () => {
    expect(parseEnvCustomJsonl('not json at all', noClaimed)).toEqual({});
  });

  it('skips blank lines', () => {
    const content = [
      '{"name":"FIRST","value":"a"}',
      '',
      '   ',
      '{"name":"SECOND","value":"b"}',
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({
      FIRST: 'a',
      SECOND: 'b',
    });
  });

  it('handles broken append (truncated JSON at end of file)', () => {
    const content = [
      '{"name":"BEFORE","value":"ok"}',
      '{"name":"TRUNCA',  // simulates partial write / crash mid-append
    ].join('\n');

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({ BEFORE: 'ok' });
  });

  it('handles broken append with trailing newline after truncation', () => {
    const content =
      '{"name":"SAVED","value":"yes"}\n' +
      '{"name":"HALF","val\n' +
      '{"name":"GONE","value":"lost"}\n';

    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({ SAVED: 'yes' });
  });

  it('preserves values containing special characters', () => {
    const content = '{"name":"MY_URL","value":"https://example.com/path?q=1&x=2"}';
    expect(parseEnvCustomJsonl(content, noClaimed)).toEqual({
      MY_URL: 'https://example.com/path?q=1&x=2',
    });
  });
});

// ── writeEnvVarsFile ──────────────────────────────────────────────

describe('writeEnvVarsFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-vars-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readOutput(): string {
    return fs.readFileSync(path.join(tmpDir, '.env-vars'), 'utf-8');
  }

  function writeCustomJsonl(lines: string[]): void {
    fs.writeFileSync(path.join(tmpDir, 'env-custom.jsonl'), lines.join('\n'));
  }

  it('writes credential env vars as export lines', () => {
    writeEnvVarsFile(
      { GH_TOKEN: 'ghp_sub123', GITHUB_TOKEN: 'ghp_sub123' },
      tmpDir,
      path.join(tmpDir, '.env-vars'),
    );

    const content = readOutput();
    expect(content).toContain('export GH_TOKEN=ghp_sub123');
    expect(content).toContain('export GITHUB_TOKEN=ghp_sub123');
  });

  it('merges custom env vars after credential vars', () => {
    writeCustomJsonl([
      '{"name":"MY_API_URL","value":"https://example.com"}',
    ]);

    writeEnvVarsFile(
      { GH_TOKEN: 'ghp_sub' },
      tmpDir,
      path.join(tmpDir, '.env-vars'),
    );

    const lines = readOutput().trim().split('\n');
    // Credential vars come first
    expect(lines[0]).toBe('export GH_TOKEN=ghp_sub');
    // Custom vars come after
    expect(lines[1]).toBe('export MY_API_URL=https://example.com');
  });

  it('credentials take priority over custom env vars with same name', () => {
    writeCustomJsonl([
      '{"name":"GH_TOKEN","value":"agent-wants-override"}',
      '{"name":"CUSTOM_ONLY","value":"ok"}',
    ]);

    writeEnvVarsFile(
      { GH_TOKEN: 'ghp_credential_sub' },
      tmpDir,
      path.join(tmpDir, '.env-vars'),
    );

    const content = readOutput();
    // Credential value wins
    expect(content).toContain('export GH_TOKEN=ghp_credential_sub');
    // Agent override excluded
    expect(content).not.toContain('agent-wants-override');
    // Non-conflicting custom var is included
    expect(content).toContain('export CUSTOM_ONLY=ok');
  });

  it('excludes reserved names from custom env vars', () => {
    writeCustomJsonl([
      '{"name":"PATH","value":"/evil"}',
      '{"name":"PROXY_HOST","value":"evil"}',
      '{"name":"ANTHROPIC_API_KEY","value":"evil"}',
      '{"name":"SAFE_VAR","value":"ok"}',
    ]);

    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));

    const content = readOutput();
    expect(content).not.toContain('PATH');
    expect(content).not.toContain('PROXY_HOST');
    expect(content).not.toContain('ANTHROPIC_API_KEY');
    expect(content).toContain('export SAFE_VAR=ok');
  });

  it('writes empty file when no env vars exist', () => {
    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));
    expect(readOutput()).toBe('');
  });

  it('writes empty file when env-custom.jsonl does not exist', () => {
    // No custom file created — should not throw
    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));
    expect(readOutput()).toBe('');
  });

  it('handles broken env-custom.jsonl (stops at corruption)', () => {
    writeCustomJsonl([
      '{"name":"BEFORE_BREAK","value":"ok"}',
      'corrupted line here',
      '{"name":"AFTER_BREAK","value":"lost"}',
    ]);

    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));

    const content = readOutput();
    expect(content).toContain('export BEFORE_BREAK=ok');
    expect(content).not.toContain('AFTER_BREAK');
  });

  it('handles env-custom.jsonl with truncated last line (crash mid-append)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'env-custom.jsonl'),
      '{"name":"GOOD","value":"yes"}\n{"name":"TRUNC',
    );

    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));

    const content = readOutput();
    expect(content).toContain('export GOOD=yes');
    expect(content).not.toContain('TRUNC');
  });

  it('handles entirely broken env-custom.jsonl', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'env-custom.jsonl'),
      'not json\nalso not json\n',
    );

    writeEnvVarsFile(
      { GH_TOKEN: 'sub' },
      tmpDir,
      path.join(tmpDir, '.env-vars'),
    );

    const content = readOutput();
    // Credential vars still written
    expect(content).toBe('export GH_TOKEN=sub\n');
  });

  it('custom vars with last-write-wins across appends', () => {
    writeCustomJsonl([
      '{"name":"CONFIG","value":"v1"}',
      '{"name":"OTHER","value":"x"}',
      '{"name":"CONFIG","value":"v2"}',
    ]);

    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));

    const content = readOutput();
    expect(content).toContain('export CONFIG=v2');
    // v1 should not appear
    expect(content).not.toContain('v1');
  });

  it('output ends with newline when non-empty', () => {
    writeCustomJsonl(['{"name":"FOO","value":"bar"}']);
    writeEnvVarsFile({}, tmpDir, path.join(tmpDir, '.env-vars'));
    expect(readOutput()).toMatch(/\n$/);
  });
});
