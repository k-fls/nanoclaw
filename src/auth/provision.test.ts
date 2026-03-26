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

const { initCredentialStore, encrypt, saveCredential } = await import(
  './store.js'
);
const { registerProvider, getAllProviders } = await import('./registry.js');
const { resolveScope, importEnvToDefault } = await import('./provision.js');
const { readEnvFile } = await import('../env.js');

import type { CredentialProvider } from './types.js';
import type { RegisteredGroup } from '../types.js';

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

describe('resolveScope', () => {
  const stub = (service: string, hasValid: (scope: string) => boolean): CredentialProvider => ({
    service,
    displayName: 'Test',
    hasValidCredentials: hasValid,
    provision: () => ({ env: {} }),
    storeResult: () => {},
    authOptions: () => [],
  });

  it('returns group folder when no credentials anywhere', () => {
    registerProvider(stub('test-none', () => false));
    expect(resolveScope(makeGroup('no-creds'))).toBe('no-creds');
  });

  it('returns group folder when group has credentials', () => {
    registerProvider(stub('test-group', (s) => s === 'my-group'));
    expect(resolveScope(makeGroup('my-group'))).toBe('my-group');
  });

  it('falls back to default when useDefaultCredentials is true', () => {
    registerProvider(stub('test-default', (s) => s === 'default'));
    expect(resolveScope(makeGroup('some-group', { useDefaultCredentials: true }))).toBe('default');
  });

  it('defaults to useDefaultCredentials=true for main group', () => {
    registerProvider(stub('test-main', (s) => s === 'default'));
    expect(resolveScope(makeGroup('main-group', { isMain: true }))).toBe('default');
  });

  it('does NOT default to useDefaultCredentials=true for non-main group', () => {
    registerProvider(stub('test-nonmain', () => false));
    expect(resolveScope(makeGroup('other-group'))).toBe('other-group');
  });

  it('explicit useDefaultCredentials=false overrides isMain', () => {
    registerProvider(stub('test-override', () => false));
    expect(resolveScope(makeGroup('main-locked', { isMain: true, useDefaultCredentials: false }))).toBe('main-locked');
  });

  it('does NOT fall back to default when useDefaultCredentials is not set', () => {
    registerProvider(stub('test-no-default', () => false));
    expect(resolveScope(makeGroup('isolated-group'))).toBe('isolated-group');
  });

  it('does NOT fall back to default when useDefaultCredentials is false', () => {
    registerProvider(stub('test-explicit-false', () => false));
    expect(resolveScope(makeGroup('locked-group', { useDefaultCredentials: false }))).toBe('locked-group');
  });

  it('group scope takes precedence over default', () => {
    registerProvider(stub('test-precedence', () => true));
    expect(resolveScope(makeGroup('priority-group', { useDefaultCredentials: true }))).toBe('priority-group');
  });
});

describe('importEnvToDefault', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('calls importEnv on providers that have it', () => {
    const importEnvMock = vi.fn();
    const provider: CredentialProvider = {
      service: 'test-import',
      displayName: 'Test',
      hasValidCredentials: () => false,
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
      importEnv: importEnvMock,
    };
    registerProvider(provider);

    importEnvToDefault();
    expect(importEnvMock).toHaveBeenCalledWith('default');
  });

  it('skips providers without importEnv', () => {
    const provider: CredentialProvider = {
      service: 'test-no-import',
      displayName: 'Test',
      hasValidCredentials: () => false,
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    // Should not throw
    importEnvToDefault();
  });
});
