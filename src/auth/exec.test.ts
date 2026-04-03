import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
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
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./credential-proxy.js', () => ({
  getProxy: () => ({
    registerContainerIP: vi.fn(),
    unregisterContainerIP: vi.fn(),
  }),
}));

vi.mock('./container-args.js', () => ({
  allocateContainerIP: () => ({ ip: '172.18.0.99', release: vi.fn() }),
  applyTransparentProxyArgs: vi.fn(),
  networkArgs: () => ['--net=nanoclaw'],
}));

const spawnArgs: string[][] = [];
vi.mock('child_process', () => ({
  spawn: (_bin: string, args: string[]) => {
    spawnArgs.push(args);
    const proc = new EventEmitter() as any;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = 99999;
    return proc;
  },
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

describe('startExecInContainer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-exec-'));
    spawnArgs.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not mount /home/node (no persistent home for auth containers)', async () => {
    // Fresh import to pick up all mocks
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      DATA_DIR: tmpDir,
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      IDLE_TIMEOUT: 1800000,
      TIMEZONE: 'UTC',
    }));
    vi.doMock('../container-runtime.js', () => ({
      CONTAINER_RUNTIME_BIN: 'docker',
      stopContainer: vi.fn(),
      hostGatewayArgs: () => [],
      readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../credential-proxy.js', () => ({
      getProxy: () => ({
        registerContainerIP: vi.fn(),
        unregisterContainerIP: vi.fn(),
      }),
    }));
    vi.doMock('./container-args.js', () => ({
      allocateContainerIP: () => ({ ip: '172.18.0.99', release: vi.fn() }),
      applyTransparentProxyArgs: vi.fn(),
      networkArgs: () => ['--net=nanoclaw'],
    }));
    vi.doMock('child_process', () => ({
      spawn: (_bin: string, args: string[]) => {
        spawnArgs.push(args);
        const proc = new EventEmitter() as any;
        proc.stdin = new PassThrough();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.pid = 99999;
        return proc;
      },
    }));

    const { startExecInContainer } = await import('./exec.js');

    startExecInContainer(['echo', 'test'], tmpDir, {
      credentialScope: 'test-scope' as any,
    });

    expect(spawnArgs.length).toBe(1);
    const allArgs = spawnArgs[0].join(' ');

    // Must NOT have /home/node as a mount target (only /home/node/.claude would be agent-side)
    const volumeArgs = spawnArgs[0].filter((_, i, a) => a[i - 1] === '-v');
    const homeMounts = volumeArgs.filter(
      (v) => v.includes(':/home/node') && !v.includes(':/home/node/'),
    );
    expect(homeMounts).toHaveLength(0);
  });
});
