import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const tmpDir = '/tmp/nanoclaw-test-cli-' + process.pid;
  return {
    CLAUDE_CLI_DIR: tmpDir,
    CLAUDE_CLI_UPDATE: '',
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    parseClaudeCliUpdate: (await import('../config.js')).parseClaudeCliUpdate,
  };
});

vi.mock('../container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getClaudeCliPath } from './updater.js';
import { CLAUDE_CLI_DIR } from '../config.js';

describe('getClaudeCliPath', () => {
  beforeEach(() => {
    fs.mkdirSync(
      path.join(CLAUDE_CLI_DIR, 'node_modules', '@anthropic-ai', 'claude-code'),
      { recursive: true },
    );
  });

  afterEach(() => {
    fs.rmSync(CLAUDE_CLI_DIR, { recursive: true, force: true });
  });

  it('returns path when cli.js exists', () => {
    const cliJs = path.join(
      CLAUDE_CLI_DIR,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js',
    );
    fs.writeFileSync(cliJs, '#!/usr/bin/env node\n');
    expect(getClaudeCliPath()).toBe(cliJs);
  });

  it('returns null when cli.js does not exist', () => {
    expect(getClaudeCliPath()).toBeNull();
  });
});

describe('parseClaudeCliUpdate', () => {
  // Test the config parser directly since it's pure
  let parseClaudeCliUpdate: typeof import('../config.js').parseClaudeCliUpdate;

  beforeEach(async () => {
    parseClaudeCliUpdate = (await import('../config.js')).parseClaudeCliUpdate;
  });

  it('returns off for empty string', () => {
    expect(parseClaudeCliUpdate('')).toEqual({
      mode: 'off',
      intervalMs: 0,
      version: '',
    });
  });

  it('parses hours duration', () => {
    expect(parseClaudeCliUpdate('24h')).toEqual({
      mode: 'latest',
      intervalMs: 24 * 3600000,
      version: '',
    });
  });

  it('parses days duration', () => {
    expect(parseClaudeCliUpdate('1d')).toEqual({
      mode: 'latest',
      intervalMs: 86400000,
      version: '',
    });
  });

  it('parses minutes duration', () => {
    expect(parseClaudeCliUpdate('30m')).toEqual({
      mode: 'latest',
      intervalMs: 30 * 60000,
      version: '',
    });
  });

  it('parses semver as pinned', () => {
    expect(parseClaudeCliUpdate('2.1.92')).toEqual({
      mode: 'pinned',
      intervalMs: 0,
      version: '2.1.92',
    });
  });

  it('parses major.minor as pinned', () => {
    expect(parseClaudeCliUpdate('2.1')).toEqual({
      mode: 'pinned',
      intervalMs: 0,
      version: '2.1',
    });
  });

  it('returns off for unrecognized input', () => {
    expect(parseClaudeCliUpdate('foo')).toEqual({
      mode: 'off',
      intervalMs: 0,
      version: '',
    });
  });
});
