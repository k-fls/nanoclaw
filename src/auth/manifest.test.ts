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
  distributeAllManifests,
  revokeGranteeManifests,
  createBorrowedLink,
  removeBorrowedLink,
  regenerateAllManifests,
} from './manifest.js';
import type { CredentialScope } from './oauth-types.js';
import { asGroupScope } from './oauth-types.js';

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

// ── Helpers for distribution / symlink tests ────────────────────────

const groupsDir = path.join(tmpDir, 'groups');

function grantedManifestPath(
  granteeFolder: string,
  grantorFolder: string,
  providerId: string,
): string {
  return path.join(
    groupsDir,
    granteeFolder,
    'credentials',
    'granted',
    grantorFolder,
    `${providerId}.jsonl`,
  );
}

function readGrantedManifest(
  granteeFolder: string,
  grantorFolder: string,
  providerId: string,
): string[] {
  const p = grantedManifestPath(granteeFolder, grantorFolder, providerId);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
}

/** Flush fire-and-forget microtasks from asyncDistribute. */
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('manifest distribution to grantees', () => {
  afterEach(() => {
    fs.rmSync(credDir, { recursive: true, force: true });
    fs.rmSync(groupsDir, { recursive: true, force: true });
  });

  it('onKeysFileWritten distributes manifest to grantees via group resolver', async () => {
    const scope = 'grantor-g' as unknown as CredentialScope;
    mockKeysData['grantor-g/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };

    setManifestGroupResolver((folder) => {
      if (folder === 'grantor-g') {
        return {
          name: 'Grantor',
          folder: 'grantor-g',
          trigger: '',
          added_at: '',
          containerConfig: { credentialGrantees: new Set(['grantee-a', 'grantee-b']) },
        };
      }
      return undefined;
    });

    onKeysFileWritten(scope, 'claude');
    await flush();

    // Both grantees should have received the manifest
    expect(readGrantedManifest('grantee-a', 'grantor-g', 'claude')).toHaveLength(1);
    expect(readGrantedManifest('grantee-b', 'grantor-g', 'claude')).toHaveLength(1);

    const entry = JSON.parse(readGrantedManifest('grantee-a', 'grantor-g', 'claude')[0]);
    expect(entry).toEqual({
      provider: 'claude',
      name: 'oauth',
      credScope: 'grantor-g',
    });
  });

  it('onKeysFileDeleted removes manifest from grantees', async () => {
    const scope = 'grantor-del' as unknown as CredentialScope;
    mockKeysData['grantor-del/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };

    setManifestGroupResolver((folder) => {
      if (folder === 'grantor-del') {
        return {
          name: 'Grantor',
          folder: 'grantor-del',
          trigger: '',
          added_at: '',
          containerConfig: { credentialGrantees: new Set(['grantee-del']) },
        };
      }
      return undefined;
    });

    // Write first
    onKeysFileWritten(scope, 'claude');
    await flush();
    expect(readGrantedManifest('grantee-del', 'grantor-del', 'claude')).toHaveLength(1);

    // Delete
    onKeysFileDeleted(scope, 'claude');
    await flush();
    expect(readGrantedManifest('grantee-del', 'grantor-del', 'claude')).toHaveLength(0);
  });

  it('onKeysFileDeleted without providerId removes whole scope from grantees', async () => {
    const scope = 'grantor-whole' as unknown as CredentialScope;
    mockKeysData['grantor-whole/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };
    mockKeysData['grantor-whole/github'] = {
      v: 1,
      pat: { value: 'ghp_abc', expires_ts: 0, updated_ts: 0 },
    };

    setManifestGroupResolver((folder) => {
      if (folder === 'grantor-whole') {
        return {
          name: 'Grantor',
          folder: 'grantor-whole',
          trigger: '',
          added_at: '',
          containerConfig: { credentialGrantees: new Set(['grantee-whole']) },
        };
      }
      return undefined;
    });

    onKeysFileWritten(scope, 'claude');
    onKeysFileWritten(scope, 'github');
    await flush();
    expect(readGrantedManifest('grantee-whole', 'grantor-whole', 'claude')).toHaveLength(1);
    expect(readGrantedManifest('grantee-whole', 'grantor-whole', 'github')).toHaveLength(1);

    // Delete whole scope (no providerId)
    onKeysFileDeleted(scope);
    await flush();

    // Both provider manifests should be gone from the grantee
    const grantedDir = path.join(
      groupsDir,
      'grantee-whole',
      'credentials',
      'granted',
      'grantor-whole',
    );
    expect(fs.existsSync(grantedDir)).toBe(false);
  });

  it('skips distribution when group resolver returns no grantees', async () => {
    const scope = 'no-grantees' as unknown as CredentialScope;
    mockKeysData['no-grantees/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };

    setManifestGroupResolver(() => ({
      name: 'Solo',
      folder: 'no-grantees',
      trigger: '',
      added_at: '',
      // No credentialGrantees
    }));

    // Should not throw
    onKeysFileWritten(scope, 'claude');
    await flush();
  });
});

describe('distributeAllManifests', () => {
  afterEach(() => {
    fs.rmSync(credDir, { recursive: true, force: true });
    fs.rmSync(groupsDir, { recursive: true, force: true });
  });

  it('copies all existing manifests from grantor to new grantee', () => {
    const scope = 'dist-all' as unknown as CredentialScope;
    mockKeysData['dist-all/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };
    mockKeysData['dist-all/github'] = {
      v: 1,
      pat: { value: 'ghp_abc', expires_ts: 0, updated_ts: 0 },
    };

    // Write manifests (without distribution — no resolver set)
    setManifestGroupResolver(() => undefined);
    onKeysFileWritten(scope, 'claude');
    onKeysFileWritten(scope, 'github');

    // Now distribute to a new grantee
    distributeAllManifests('dist-all', 'new-grantee');

    expect(readGrantedManifest('new-grantee', 'dist-all', 'claude')).toHaveLength(1);
    expect(readGrantedManifest('new-grantee', 'dist-all', 'github')).toHaveLength(1);
  });

  it('no-op when grantor has no manifests', () => {
    // Should not throw
    distributeAllManifests('nonexistent-grantor', 'some-grantee');
  });
});

describe('revokeGranteeManifests', () => {
  afterEach(() => {
    fs.rmSync(credDir, { recursive: true, force: true });
    fs.rmSync(groupsDir, { recursive: true, force: true });
  });

  it('removes all granted manifests from grantee for a specific grantor', () => {
    const scope = 'revoke-g' as unknown as CredentialScope;
    mockKeysData['revoke-g/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };

    setManifestGroupResolver(() => undefined);
    onKeysFileWritten(scope, 'claude');
    distributeAllManifests('revoke-g', 'target-grantee');
    expect(readGrantedManifest('target-grantee', 'revoke-g', 'claude')).toHaveLength(1);

    revokeGranteeManifests('revoke-g', 'target-grantee');

    const grantedDir = path.join(
      groupsDir,
      'target-grantee',
      'credentials',
      'granted',
      'revoke-g',
    );
    expect(fs.existsSync(grantedDir)).toBe(false);
  });

  it('removes borrowed symlink if it pointed to the revoked grantor', () => {
    const scope = 'revoke-link' as unknown as CredentialScope;
    mockKeysData['revoke-link/claude'] = {
      v: 1,
      oauth: { value: 'tok_abc', expires_ts: 0, updated_ts: 0 },
    };

    setManifestGroupResolver(() => undefined);
    onKeysFileWritten(scope, 'claude');
    distributeAllManifests('revoke-link', 'link-grantee');

    // Create borrowed symlink pointing to this grantor
    createBorrowedLink('link-grantee', 'revoke-link');
    const borrowedLink = path.join(groupsDir, 'link-grantee', 'credentials', 'borrowed');
    expect(fs.lstatSync(borrowedLink).isSymbolicLink()).toBe(true);

    // Revoke — should also remove the borrowed symlink
    revokeGranteeManifests('revoke-link', 'link-grantee');
    expect(fs.existsSync(borrowedLink)).toBe(false);
  });

  it('keeps borrowed symlink if it points to a different grantor', () => {
    createBorrowedLink('keep-grantee', 'other-grantor');
    const borrowedLink = path.join(groupsDir, 'keep-grantee', 'credentials', 'borrowed');
    expect(fs.lstatSync(borrowedLink).isSymbolicLink()).toBe(true);

    // Revoke a different grantor — symlink should survive
    revokeGranteeManifests('some-grantor', 'keep-grantee');
    expect(fs.lstatSync(borrowedLink).isSymbolicLink()).toBe(true);

    // Clean up
    fs.rmSync(path.join(groupsDir, 'keep-grantee'), { recursive: true, force: true });
  });
});

describe('createBorrowedLink / removeBorrowedLink', () => {
  afterEach(() => {
    fs.rmSync(groupsDir, { recursive: true, force: true });
  });

  it('creates a symlink at credentials/borrowed pointing to granted/{grantor}', () => {
    createBorrowedLink('borrow-grantee', 'the-grantor');

    const link = path.join(groupsDir, 'borrow-grantee', 'credentials', 'borrowed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('granted/the-grantor');
  });

  it('replaces existing symlink when grantor changes', () => {
    createBorrowedLink('switch-grantee', 'grantor-1');
    createBorrowedLink('switch-grantee', 'grantor-2');

    const link = path.join(groupsDir, 'switch-grantee', 'credentials', 'borrowed');
    expect(fs.readlinkSync(link)).toBe('granted/grantor-2');
  });

  it('removeBorrowedLink removes the symlink', () => {
    createBorrowedLink('rm-grantee', 'some-grantor');
    const link = path.join(groupsDir, 'rm-grantee', 'credentials', 'borrowed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

    removeBorrowedLink('rm-grantee');
    expect(fs.existsSync(link)).toBe(false);
  });

  it('removeBorrowedLink is no-op when no symlink exists', () => {
    // Should not throw
    removeBorrowedLink('nonexistent-group');
  });
});

describe('regenerateAllManifests', () => {
  afterEach(() => {
    fs.rmSync(credDir, { recursive: true, force: true });
  });

  it('regenerates manifests for all scopes from keys files on disk', () => {
    // Write keys files directly to disk (simulating existing credential store)
    const scopeDir = path.join(credDir, 'regen-scope');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopeDir, 'claude.keys.json'),
      JSON.stringify({ v: 1 }),
    );

    // Set up mock data so buildManifestLines produces output
    mockKeysData['regen-scope/claude'] = {
      v: 1,
      oauth: { value: 'tok_regen', expires_ts: 0, updated_ts: 0 },
    };

    regenerateAllManifests();

    const lines = readManifestFile('regen-scope', 'claude');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      provider: 'claude',
      name: 'oauth',
      credScope: 'regen-scope',
    });
  });

  it('handles multiple scopes and providers', () => {
    // Scope A
    const scopeA = path.join(credDir, 'scope-a');
    fs.mkdirSync(scopeA, { recursive: true });
    fs.writeFileSync(path.join(scopeA, 'claude.keys.json'), JSON.stringify({ v: 1 }));
    fs.writeFileSync(path.join(scopeA, 'github.keys.json'), JSON.stringify({ v: 1 }));

    // Scope B
    const scopeB = path.join(credDir, 'scope-b');
    fs.mkdirSync(scopeB, { recursive: true });
    fs.writeFileSync(path.join(scopeB, 'claude.keys.json'), JSON.stringify({ v: 1 }));

    mockKeysData['scope-a/claude'] = { v: 1, oauth: { value: 'a', expires_ts: 0, updated_ts: 0 } };
    mockKeysData['scope-a/github'] = { v: 1, pat: { value: 'b', expires_ts: 0, updated_ts: 0 } };
    mockKeysData['scope-b/claude'] = { v: 1, oauth: { value: 'c', expires_ts: 0, updated_ts: 0 } };

    regenerateAllManifests();

    expect(readManifestFile('scope-a', 'claude')).toHaveLength(1);
    expect(readManifestFile('scope-a', 'github')).toHaveLength(1);
    expect(readManifestFile('scope-b', 'claude')).toHaveLength(1);
  });

  it('no-op when credentials directory does not exist', () => {
    fs.rmSync(credDir, { recursive: true, force: true });
    // Should not throw
    regenerateAllManifests();
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
