import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// vi.mock factories are hoisted — must use inline values, not module-scope vars.
const tmpDir = path.join(os.tmpdir(), `manifest-test-${process.pid}`);
const credDir = path.join(tmpDir, 'credentials');
fs.mkdirSync(tmpDir, { recursive: true });

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./store.js', async () => {
  const _os = await import('os');
  const _path = await import('path');
  const _dir = _path.default.join(
    _os.default.tmpdir(),
    `manifest-test-${process.pid}`,
    'credentials',
  );
  return { CREDENTIALS_DIR: _dir };
});

vi.mock('../group-folder.js', async () => {
  const _os = await import('os');
  const _path = await import('path');
  const _tmp = _path.default.join(
    _os.default.tmpdir(),
    `manifest-test-${process.pid}`,
  );
  return {
    resolveGroupFolderPath: (folder: string) =>
      _path.default.join(_tmp, 'groups', folder),
  };
});

// Mock readKeysFile to return test data
const mockKeysData: Record<string, Record<string, unknown>> = {};
vi.mock('./token-substitute.js', () => ({
  readKeysFile: (scope: string, providerId: string) =>
    mockKeysData[`${scope}/${providerId}`] ?? {},
}));

import {
  registerManifestBuilder,
  onKeysFileWritten,
  onKeysFileDeleted,
  setManifestGroupResolver,
} from './manifest.js';
import type { CredentialScope } from './oauth-types.js';

function readManifestFile(scope: string, providerId: string): string[] {
  const p = path.join(credDir, scope, 'manifests', `${providerId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
}

describe('manifest builder registry', () => {
  afterEach(() => {
    // Clean up temp files between tests
    fs.rmSync(credDir, { recursive: true, force: true });
  });

  it('default builder uses readKeysFile', () => {
    const scope = 'default-scope' as unknown as CredentialScope;
    mockKeysData['default-scope/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };

    onKeysFileWritten(scope, 'claude');

    const lines = readManifestFile('default-scope', 'claude');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual({
      provider: 'claude',
      name: 'oauth',
      credScope: 'default-scope',
    });
  });

  it('custom builder overrides default', () => {
    const scope = 'custom-scope' as unknown as CredentialScope;
    const customLine = JSON.stringify({
      provider: 'ssh',
      type: 'pubkey',
      host: '*',
    });

    registerManifestBuilder('ssh', () => [customLine]);

    // Set up keys data that the default builder would use — it should be ignored
    mockKeysData['custom-scope/ssh'] = {
      default: { value: 'key_data', expires_ts: 0, updated_ts: 0 },
    };

    onKeysFileWritten(scope, 'ssh');

    const lines = readManifestFile('custom-scope', 'ssh');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      provider: 'ssh',
      type: 'pubkey',
      host: '*',
    });
  });

  it('builder returning [] suppresses manifest', () => {
    const scope = 'no-manifest' as unknown as CredentialScope;

    registerManifestBuilder('pem', () => []);

    mockKeysData['no-manifest/pem'] = {
      password: { value: 'secret', expires_ts: 0, updated_ts: 0 },
    };

    onKeysFileWritten(scope, 'pem');

    // Manifest file should exist but be empty (just a newline)
    const lines = readManifestFile('no-manifest', 'pem');
    expect(lines).toHaveLength(0);
  });

  it('builder receives correct scope and providerId', () => {
    const scope = 'args-test' as unknown as CredentialScope;
    const builderSpy = vi.fn(() => ['{"test":true}']);

    registerManifestBuilder('args-prov', builderSpy);
    onKeysFileWritten(scope, 'args-prov');

    expect(builderSpy).toHaveBeenCalledWith(scope, 'args-prov');
  });
});

describe('manifest lifecycle hooks', () => {
  afterEach(() => {
    fs.rmSync(credDir, { recursive: true, force: true });
  });

  it('onWrite hook fires after manifest is written', () => {
    const scope = 'hook-write' as unknown as CredentialScope;
    const onWrite = vi.fn();

    registerManifestBuilder('hook-w', () => ['{"ok":true}'], { onWrite });

    onKeysFileWritten(scope, 'hook-w');

    expect(onWrite).toHaveBeenCalledOnce();
    expect(onWrite).toHaveBeenCalledWith(scope, 'hook-w');
    // Manifest file should exist when hook fires
    expect(readManifestFile('hook-write', 'hook-w')).toHaveLength(1);
  });

  it('onDelete hook fires after manifest is deleted', () => {
    const scope = 'hook-del' as unknown as CredentialScope;
    const onDelete = vi.fn();

    registerManifestBuilder('hook-d', () => ['{"ok":true}'], { onDelete });

    // First write, then delete
    onKeysFileWritten(scope, 'hook-d');
    expect(readManifestFile('hook-del', 'hook-d')).toHaveLength(1);

    onKeysFileDeleted(scope, 'hook-d');

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(scope, 'hook-d');
    expect(readManifestFile('hook-del', 'hook-d')).toHaveLength(0);
  });

  it('no hook registered — no error', () => {
    const scope = 'no-hook' as unknown as CredentialScope;
    mockKeysData['no-hook/vanilla'] = {
      api_key: { value: 'key', expires_ts: 0, updated_ts: 0 },
    };

    // Should not throw when no hooks are registered
    expect(() => onKeysFileWritten(scope, 'vanilla')).not.toThrow();
    expect(() => onKeysFileDeleted(scope, 'vanilla')).not.toThrow();
  });

  it('onWrite not called if manifest generation fails', () => {
    const scope = 'fail-scope' as unknown as CredentialScope;
    const onWrite = vi.fn();
    const builder = vi.fn(() => {
      throw new Error('builder broke');
    });

    registerManifestBuilder('fail-prov', builder, { onWrite });

    // Should not throw, but should log warning
    onKeysFileWritten(scope, 'fail-prov');

    expect(builder).toHaveBeenCalled();
    expect(onWrite).not.toHaveBeenCalled();
  });
});

describe('provider ID collision in registry', () => {
  // This tests the registry.ts collision guard — import fresh to avoid
  // interference from other test files that register providers.
  it('registerProvider throws on duplicate ID', async () => {
    vi.resetModules();
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('./credential-proxy.js', () => ({
      getProxy: () => ({
        registerProviderHost: vi.fn(),
        registerAnchoredRule: vi.fn(),
      }),
    }));

    const { registerProvider } = await import('./registry.js');

    const stub = {
      id: 'collision-test',
      displayName: 'test',
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
    };

    registerProvider(stub);
    expect(() => registerProvider({ ...stub })).toThrow(
      "Provider ID 'collision-test' already registered",
    );
  });
});
