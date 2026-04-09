import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = path.join(os.tmpdir(), `ssh-pending-test-${process.pid}`);

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../store.js', async () => {
  const _os = await import('os');
  const _path = await import('path');
  return {
    CREDENTIALS_DIR: _path.default.join(
      _os.default.tmpdir(),
      `ssh-pending-test-${process.pid}`,
      'credentials',
    ),
  };
});

import {
  addPendingRequest,
  hasPendingRequest,
  removePendingRequest,
  clearAllPending,
} from './pending.js';
import type { GroupScope } from '../oauth-types.js';

const scope = 'test-group' as unknown as GroupScope;

function pendingFilePath(): string {
  return path.join(tmpDir, 'credentials', scope as string, 'ssh.pending.json');
}

function readPending(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(pendingFilePath(), 'utf-8'));
  } catch {
    return {};
  }
}

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, 'credentials', scope as string), {
    recursive: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addPendingRequest', () => {
  it('creates a new pending entry', () => {
    const result = addPendingRequest(scope, 'prod-db');
    expect(result.accepted).toBe(true);
    expect(result.capReached).toBe(false);
    const data = readPending();
    expect(data['prod-db']).toBeTypeOf('number');
  });

  it('accepts duplicate alias (idempotent)', () => {
    addPendingRequest(scope, 'staging');
    const result = addPendingRequest(scope, 'staging');
    expect(result.accepted).toBe(true);
  });

  it('accepts up to cap and signals capReached', () => {
    for (let i = 0; i < 9; i++) {
      const r = addPendingRequest(scope, `alias-${i}`);
      expect(r.accepted).toBe(true);
      expect(r.capReached).toBe(false);
    }
    // 10th request hits the cap
    const r10 = addPendingRequest(scope, 'alias-9');
    expect(r10.accepted).toBe(true);
    expect(r10.capReached).toBe(true);
  });

  it('suppresses requests beyond the cap', () => {
    for (let i = 0; i < 10; i++) {
      addPendingRequest(scope, `alias-${i}`);
    }
    const over = addPendingRequest(scope, 'alias-overflow');
    expect(over.accepted).toBe(false);
    expect(readPending()['alias-overflow']).toBeUndefined();
  });

  it('prunes stale entries before counting', () => {
    // Write 10 stale entries directly
    const filePath = pendingFilePath();
    const stale: Record<string, number> = {};
    const oldTs = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    for (let i = 0; i < 10; i++) {
      stale[`stale-${i}`] = oldTs;
    }
    fs.writeFileSync(filePath, JSON.stringify(stale));

    // New request should be accepted (stale ones pruned)
    const result = addPendingRequest(scope, 'fresh');
    expect(result.accepted).toBe(true);
    const data = readPending();
    expect(Object.keys(data)).toEqual(['fresh']);
  });
});

describe('hasPendingRequest', () => {
  it('returns true for existing entry', () => {
    addPendingRequest(scope, 'db');
    expect(hasPendingRequest(scope, 'db')).toBe(true);
  });

  it('returns false for missing entry', () => {
    expect(hasPendingRequest(scope, 'nope')).toBe(false);
  });

  it('returns false for stale entry', () => {
    const filePath = pendingFilePath();
    const oldTs = Date.now() - 2 * 60 * 60 * 1000;
    fs.writeFileSync(filePath, JSON.stringify({ old: oldTs }));
    expect(hasPendingRequest(scope, 'old')).toBe(false);
  });
});

describe('removePendingRequest', () => {
  it('removes existing entry and returns true', () => {
    addPendingRequest(scope, 'target');
    expect(removePendingRequest(scope, 'target')).toBe(true);
    expect(readPending()['target']).toBeUndefined();
  });

  it('returns false for missing entry', () => {
    expect(removePendingRequest(scope, 'ghost')).toBe(false);
  });
});

describe('clearAllPending', () => {
  it('clears all entries and returns count', () => {
    addPendingRequest(scope, 'a');
    addPendingRequest(scope, 'b');
    addPendingRequest(scope, 'c');
    const count = clearAllPending(scope);
    expect(count).toBe(3);
    expect(readPending()).toEqual({});
  });

  it('returns 0 when empty', () => {
    expect(clearAllPending(scope)).toBe(0);
  });
});
