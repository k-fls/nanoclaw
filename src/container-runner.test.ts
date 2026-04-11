import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CLAUDE_CLI_DIR: '/tmp/nanoclaw-test-cli',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy — provide a minimal proxy instance
vi.mock('./auth/credential-proxy.js', () => ({
  getProxy: vi.fn(() => ({
    hasContainerIP: vi.fn(() => false),
    registerContainerIP: vi.fn(),
    unregisterContainerIP: vi.fn(),
  })),
}));

// Mock claude-updater
vi.mock('./claude-updater/updater.js', () => ({
  cliLock: {
    acquireShared: vi.fn(async () => {}),
    releaseShared: vi.fn(),
  },
  getClaudeCliPackageDir: vi.fn(() => null),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
    execFileSync: vi.fn((_bin: string, args?: string[]) => {
      const fmt = args?.[2] ?? '';
      if (fmt.includes('State.Status')) return 'running';
      if (fmt.includes('IPAddress')) return '172.17.0.2';
      return '';
    }),
  };
});

import {
  runContainerAgent,
  buildVolumeMounts,
  snapshotContainerFiles,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const mockEngine = {} as any;
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      mockEngine,
      onOutput,
    );

    // Let IP retry loop resolve (first retry at 500ms)
    await vi.advanceTimersByTimeAsync(600);

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const mockEngine = {} as any;
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      mockEngine,
      onOutput,
    );

    // Let IP retry loop resolve
    await vi.advanceTimersByTimeAsync(600);

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const mockEngine = {} as any;
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      mockEngine,
      onOutput,
    );

    // Let IP retry loop resolve
    await vi.advanceTimersByTimeAsync(600);

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('buildVolumeMounts home persistence', () => {
  const group: RegisteredGroup = {
    name: 'Test',
    folder: 'test-home',
    trigger: '@test',
    added_at: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('agent container mounts /home/node for persistence', () => {
    const mounts = buildVolumeMounts(group, false);
    const homeMount = mounts.find((m) => m.containerPath === '/home/node');
    expect(homeMount).toBeDefined();
    expect(homeMount!.readonly).toBe(false);
    expect(homeMount!.hostPath).toContain('sessions/test-home/home');
  });

  it('/home/node is mounted before /home/node/.claude', () => {
    const mounts = buildVolumeMounts(group, false);
    const homeIdx = mounts.findIndex((m) => m.containerPath === '/home/node');
    const claudeIdx = mounts.findIndex(
      (m) => m.containerPath === '/home/node/.claude',
    );
    expect(homeIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeGreaterThan(homeIdx);
  });

  it('works the same for main group', () => {
    const mounts = buildVolumeMounts(group, true);
    const homeMount = mounts.find((m) => m.containerPath === '/home/node');
    expect(homeMount).toBeDefined();
    expect(homeMount!.readonly).toBe(false);
  });
});

describe('snapshotContainerFiles', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.cpSync).mockClear();
  });

  it('copies with preserveTimestamps so agent-runner mtime check works', () => {
    snapshotContainerFiles();

    expect(fs.cpSync).toHaveBeenCalledWith(
      expect.stringContaining('container'),
      expect.stringContaining('snapshot'),
      { recursive: true, preserveTimestamps: true },
    );
  });
});
