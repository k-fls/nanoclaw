import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Temp dir for credential store
const tmpDir = path.join(os.tmpdir(), `nanoclaw-provision-test-${Date.now()}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env.ts to control .env content
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const { initCredentialStore } = await import('./store.js');
const { registerProvider } = await import('./registry.js');
const { importEnvToDefault, createAccessCheck } = await import('./provision.js');

import type { CredentialProvider } from './types.js';
import type { RegisteredGroup } from '../types.js';
import { asGroupScope, asCredentialScope } from './oauth-types.js';
import { TokenSubstituteEngine, PersistentTokenResolver } from './token-substitute.js';

function makeGroup(
  folder: string,
  opts?: { useDefaultCredentials?: boolean; isMain?: boolean },
): RegisteredGroup {
  return {
    name: `Group ${folder}`,
    folder,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    containerConfig: opts?.useDefaultCredentials !== undefined
      ? { useDefaultCredentials: opts.useDefaultCredentials }
      : undefined,
    isMain: opts?.isMain,
  };
}

describe('createAccessCheck', () => {
  const groups = new Map<string, RegisteredGroup>();
  const resolver = (folder: string) => groups.get(folder);
  const check = createAccessCheck(resolver);

  beforeEach(() => {
    groups.clear();
  });

  it('allows default scope when useDefaultCredentials is true', () => {
    groups.set('my-group', makeGroup('my-group', { useDefaultCredentials: true }));
    expect(check(asGroupScope('my-group'), asCredentialScope('default'))).toBe(true);
  });

  it('allows default scope for main group (implicit useDefaultCredentials)', () => {
    groups.set('main-group', makeGroup('main-group', { isMain: true }));
    expect(check(asGroupScope('main-group'), asCredentialScope('default'))).toBe(true);
  });

  it('denies default scope when useDefaultCredentials is false', () => {
    groups.set('locked', makeGroup('locked', { useDefaultCredentials: false }));
    expect(check(asGroupScope('locked'), asCredentialScope('default'))).toBe(false);
  });

  it('denies default scope when useDefaultCredentials is not set (non-main)', () => {
    groups.set('regular', makeGroup('regular'));
    expect(check(asGroupScope('regular'), asCredentialScope('default'))).toBe(false);
  });

  it('denies default scope for main with explicit useDefaultCredentials=false', () => {
    groups.set('main-locked', makeGroup('main-locked', { isMain: true, useDefaultCredentials: false }));
    expect(check(asGroupScope('main-locked'), asCredentialScope('default'))).toBe(false);
  });

  it('denies default scope for unknown group', () => {
    expect(check(asGroupScope('nonexistent'), asCredentialScope('default'))).toBe(false);
  });

  it('allows own scope', () => {
    groups.set('self', makeGroup('self'));
    expect(check(asGroupScope('self'), asCredentialScope('self'))).toBe(true);
  });

  it('denies cross-group non-default scope', () => {
    groups.set('group-a', makeGroup('group-a'));
    expect(check(asGroupScope('group-a'), asCredentialScope('group-b'))).toBe(false);
  });
});

describe('importEnvToDefault', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('calls importEnv on providers that have it', () => {
    const importEnvMock = vi.fn();
    const provider: CredentialProvider = {
      id: 'test-import',
      displayName: 'Test',
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
      importEnv: importEnvMock,
    };
    registerProvider(provider);

    const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
    importEnvToDefault(engine);
    expect(importEnvMock).toHaveBeenCalledWith('default', expect.anything());
  });

  it('skips providers without importEnv', () => {
    const provider: CredentialProvider = {
      id: 'test-no-import',
      displayName: 'Test',
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
    // Should not throw
    importEnvToDefault(engine);
  });
});
