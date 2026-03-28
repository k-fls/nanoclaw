import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', () => ({
  DATA_DIR: '/mock/data',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'UTC',
}));

vi.mock('../container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  stopContainer: vi.fn(() => 'docker stop'),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  scopeDataDir,
  scopeClaudeDir,
  authSessionDir,
  CLAUDE_CONFIG_STUB,
  ensureClaudeConfigStub,
} from './exec.js';

describe('exec helpers', () => {
  describe('scopeDataDir', () => {
    it('returns DATA_DIR/sessions/{scope}', () => {
      expect(scopeDataDir('my-group')).toBe('/mock/data/sessions/my-group');
    });

    it('appends subpath segments', () => {
      expect(scopeDataDir('my-group', 'a', 'b')).toBe(
        '/mock/data/sessions/my-group/a/b',
      );
    });
  });

  describe('scopeClaudeDir', () => {
    it('returns DATA_DIR/sessions/{scope}/.claude', () => {
      expect(scopeClaudeDir('scope1')).toBe(
        '/mock/data/sessions/scope1/.claude',
      );
    });

    it('appends subpath under .claude', () => {
      expect(scopeClaudeDir('scope1', '.credentials.json')).toBe(
        '/mock/data/sessions/scope1/.claude/.credentials.json',
      );
    });
  });

  describe('authSessionDir', () => {
    it('returns DATA_DIR/sessions/{scope}/.claude-auth', () => {
      expect(authSessionDir('default')).toBe(
        '/mock/data/sessions/default/.claude-auth',
      );
    });
  });

  describe('CLAUDE_CONFIG_STUB', () => {
    it('points to DATA_DIR/.claude.json', () => {
      expect(CLAUDE_CONFIG_STUB).toBe('/mock/data/.claude.json');
    });
  });

  describe('ensureClaudeConfigStub', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates stub file when missing', async () => {
      // Re-import with a real temp DATA_DIR
      vi.resetModules();
      vi.doMock('../config.js', () => ({
        DATA_DIR: tmpDir,
        CONTAINER_IMAGE: 'nanoclaw-agent:latest',
        IDLE_TIMEOUT: 1800000,
        TIMEZONE: 'UTC',
      }));
      vi.doMock('../container-runtime.js', () => ({
        CONTAINER_RUNTIME_BIN: 'docker',
        stopContainer: vi.fn(() => 'docker stop'),
      }));
      vi.doMock('../logger.js', () => ({
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      }));

      const { ensureClaudeConfigStub: ensure, CLAUDE_CONFIG_STUB: stubPath } =
        await import('./exec.js');

      ensure();
      expect(fs.existsSync(stubPath)).toBe(true);
      expect(fs.readFileSync(stubPath, 'utf-8')).toBe('{}');
    });

    it('is a no-op when stub already exists', async () => {
      vi.resetModules();
      vi.doMock('../config.js', () => ({
        DATA_DIR: tmpDir,
        CONTAINER_IMAGE: 'nanoclaw-agent:latest',
        IDLE_TIMEOUT: 1800000,
        TIMEZONE: 'UTC',
      }));
      vi.doMock('../container-runtime.js', () => ({
        CONTAINER_RUNTIME_BIN: 'docker',
        stopContainer: vi.fn(() => 'docker stop'),
      }));
      vi.doMock('../logger.js', () => ({
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      }));

      const { ensureClaudeConfigStub: ensure, CLAUDE_CONFIG_STUB: stubPath } =
        await import('./exec.js');

      // Create it first
      ensure();
      const stat1 = fs.statSync(stubPath);

      // Second call should not overwrite
      ensure();
      const stat2 = fs.statSync(stubPath);
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    });
  });
});
