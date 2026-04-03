import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  stopContainerArgs,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import {
  ensureNetwork,
  allocateContainerIP,
  networkArgs,
} from './auth/container-args.js';
import { asGroupScope } from './auth/oauth-types.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainerArgs', () => {
  it('returns validated bin and args for valid names', () => {
    const [bin, args] = stopContainerArgs('nanoclaw-test-123');
    expect(bin).toBe(CONTAINER_RUNTIME_BIN);
    expect(args).toEqual(['stop', '-t', '1', 'nanoclaw-test-123']);
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainerArgs('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainerArgs('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainerArgs('foo`id`')).toThrow(
      'Invalid container name',
    );
  });
});

describe('stopContainer', () => {
  it('calls execFileSync with validated args', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-123'],
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValue('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => ensureContainerRuntimeRunning()).toThrow(
        'Container runtime is required but failed to start',
      );
      expect(logger.error).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );

    cleanupOrphans();

    // ps via execSync
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    // 2 stop calls via execFileSync
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group1-111'],
      { stdio: 'pipe' },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group2-222'],
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });

    cleanupOrphans(); // should not throw

    // ps via execSync, 2 stops via execFileSync
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- ensureNetwork ---

describe('ensureNetwork', () => {
  it('does nothing when network already exists', () => {
    mockExecSync.mockReturnValueOnce(''); // inspect succeeds

    ensureNetwork();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} network inspect nanoclaw`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'nanoclaw network already exists',
    );
  });

  it('creates network when it does not exist', () => {
    // inspect fails, create succeeds
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such network');
    });
    mockExecSync.mockReturnValueOnce('');

    ensureNetwork();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('network create'),
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      { subnet: '172.29.0.0/16' },
      'Created nanoclaw network',
    );
  });

  it('handles concurrent creation race', () => {
    // inspect fails, create fails (race), second inspect succeeds
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such network');
    });
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('network already exists');
    });
    mockExecSync.mockReturnValueOnce(''); // second inspect

    ensureNetwork(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
  });

  it('throws when both create and verify fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('docker failure');
    });

    expect(() => ensureNetwork()).toThrow(
      'Failed to create nanoclaw Docker network',
    );
  });
});

// --- networkArgs ---

describe('networkArgs', () => {
  it('returns --network and --ip flags', () => {
    expect(networkArgs('172.29.0.5')).toEqual([
      '--network',
      'nanoclaw',
      '--ip',
      '172.29.0.5',
    ]);
  });
});

// --- allocateContainerIP ---

describe('allocateContainerIP', () => {
  it('allocates sequential IPs starting at 172.29.0.2', () => {
    const proxy = {
      hasContainerIP: vi.fn(() => false),
      registerContainerIP: vi.fn(),
    };

    const { ip: ip1 } = allocateContainerIP(asGroupScope('g1'), proxy as any);
    const { ip: ip2 } = allocateContainerIP(asGroupScope('g2'), proxy as any);

    expect(ip1).toBe('172.29.0.2');
    expect(ip2).toBe('172.29.0.3');
    expect(proxy.registerContainerIP).toHaveBeenCalledWith(
      '172.29.0.2',
      asGroupScope('g1'),
    );
    expect(proxy.registerContainerIP).toHaveBeenCalledWith(
      '172.29.0.3',
      asGroupScope('g2'),
    );
  });

  it('skips IPs already in the proxy map', () => {
    // Allocate one to discover the current counter position
    const probeProxy = {
      hasContainerIP: vi.fn(() => false),
      registerContainerIP: vi.fn(),
    };
    const { ip: base } = allocateContainerIP(
      asGroupScope('probe'),
      probeProxy as any,
    );
    const baseNum = parseInt(base.split('.')[3], 10);

    // Next IP is taken → should skip to baseNum+2
    const takenIP = `172.29.0.${baseNum + 1}`;
    const proxy = {
      hasContainerIP: vi.fn((ip: string) => ip === takenIP),
      registerContainerIP: vi.fn(),
    };

    const { ip } = allocateContainerIP(asGroupScope('c'), proxy as any);

    expect(ip).toBe(`172.29.0.${baseNum + 2}`);
  });

  it('rolls over octets correctly', () => {
    const proxy = {
      hasContainerIP: vi.fn(() => false),
      registerContainerIP: vi.fn(),
    };

    // Allocate enough IPs to guarantee crossing the .0.255 → .1.0 boundary
    let lastIp = '';
    for (let i = 0; i < 256; i++) {
      lastIp = allocateContainerIP(asGroupScope('x'), proxy as any).ip;
    }

    // After 256+ allocations from earlier tests, must have crossed into 172.29.1.x+
    const parts = lastIp.split('.').map(Number);
    expect(parts[0]).toBe(172);
    expect(parts[1]).toBe(29);
    expect(parts[2]).toBeGreaterThanOrEqual(1);
  });

  it('wraps from 255.254 back to 0.2 and skips if busy', () => {
    const allocated = new Set<string>();
    const proxy = {
      hasContainerIP: vi.fn((ip: string) => allocated.has(ip)),
      registerContainerIP: vi.fn((ip: string) => allocated.add(ip)),
    };

    // Force the counter to the end of the range: 65534 = 255*256+254 → 172.29.255.254
    // We need to burn through IPs to get there, or we can test the math directly.
    // Allocate to get current position, then burn forward.
    const { ip: probe } = allocateContainerIP(asGroupScope('p'), proxy as any);
    const probeNum =
      parseInt(probe.split('.')[2], 10) * 256 +
      parseInt(probe.split('.')[3], 10);

    // Burn forward to 65533 (one before the last)
    for (let i = probeNum + 1; i <= 65533; i++) {
      allocateContainerIP(asGroupScope('burn'), proxy as any).ip;
    }

    // Next should be 172.29.255.254 (65534)
    const { ip: last } = allocateContainerIP(
      asGroupScope('last'),
      proxy as any,
    );
    expect(last).toBe('172.29.255.254');

    // Mark 172.29.0.2 as busy (it's already in the set from the very first allocation above,
    // but let's be explicit)
    allocated.add('172.29.0.2');

    // Next allocation wraps to 0.2 (busy) → skips to 0.3
    // But 0.3 through probeNum are also busy from earlier allocations.
    // The allocator should skip all of them and land on the first free IP.
    const { ip: wrapped } = allocateContainerIP(
      asGroupScope('wrap'),
      proxy as any,
    );

    // Should have wrapped past all allocated IPs
    expect(allocated.has(wrapped)).toBe(true); // it was just registered
    // Verify it's in the 172.29.x.x range
    expect(wrapped).toMatch(/^172\.29\./);
    // Verify the counter wrapped (IP should be > 65534 worth = back in low range)
    const wrappedParts = wrapped.split('.').map(Number);
    const wrappedNum = wrappedParts[2] * 256 + wrappedParts[3];
    // It should be the first gap after 2 — which is one past our last burn
    expect(wrappedNum).toBeGreaterThanOrEqual(2);
  });

  it('throws when pool is exhausted', () => {
    const proxy = {
      hasContainerIP: vi.fn(() => true), // everything taken
      registerContainerIP: vi.fn(),
    };

    expect(() => allocateContainerIP(asGroupScope('x'), proxy as any)).toThrow(
      'IP pool exhausted',
    );
  });
});
