import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  asGroupScope,
  asCredentialScope,
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
} from './oauth-types.js';
import type { ChatIO } from './types.js';
import type { OAuthProvider } from './oauth-types.js';

const TEST_GROUP_SCOPE = asGroupScope('test-group');
const TEST_CRED_SCOPE = asCredentialScope('test-group');

const tmpDir = path.join(os.tmpdir(), `nanoclaw-keymgmt-test-${Date.now()}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw', 'credentials'), {
    recursive: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock GPG
const mockGpgAvailable = vi.fn(() => true);
const mockGpgDecrypt = vi.fn((_scope: string, _ct: string) => 'decrypted-key');
const mockEnsureGpgKey = vi.fn();
const mockExportPublicKey = vi.fn(
  () =>
    '-----BEGIN PGP PUBLIC KEY BLOCK-----\nfake\n-----END PGP PUBLIC KEY BLOCK-----',
);
vi.mock('./gpg.js', () => ({
  isGpgAvailable: () => mockGpgAvailable(),
  ensureGpgKey: mockEnsureGpgKey,
  exportPublicKey: mockExportPublicKey,
  gpgDecrypt: mockGpgDecrypt,
  isPgpMessage: (text: string) => text.includes('-----BEGIN PGP MESSAGE-----'),
}));

// Mock discovery registry
const mockProviders = new Map<string, OAuthProvider>();
vi.mock('./registry.js', () => ({
  getDiscoveryProvider: (id: string) => mockProviders.get(id),
  getAllDiscoveryProviderIds: () => [...mockProviders.keys()],
  getDiscoveryDir: () => tmpDir,
}));

// Import after mocks
const {
  isKeyEligibleProvider,
  getProviderCredentialIds,
  storeProviderKey,
  runInteractiveKeySetup,
  handleSetKey,
  handleDeleteKeys,
} = await import('./key-management.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(
  id: string,
  opts?: { bearerSwap?: boolean; envVars?: Record<string, string> },
): OAuthProvider {
  const rules =
    opts?.bearerSwap !== false
      ? [
          {
            anchor: `api.${id}.com`,
            pathPattern: /^\//,
            mode: 'bearer-swap' as const,
          },
        ]
      : [
          {
            anchor: `auth.${id}.com`,
            pathPattern: /^\//,
            mode: 'token-exchange' as const,
          },
        ];
  return {
    id,
    rules,
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '' },
    refreshStrategy: 'redirect',
    ...(opts?.envVars && { envVars: opts.envVars }),
  };
}

function mockTokenEngine(opts?: {
  existingRoles?: string[];
  existingSubstitute?: string | null;
}) {
  const stored: Array<{
    providerId: string;
    credentialScope: string;
    credentialId: string;
    credential: any;
  }> = [];
  const resolver = {
    store: vi.fn(
      (
        providerId: string,
        credentialScope: any,
        credentialId: string,
        credential: any,
      ) => {
        stored.push({ providerId, credentialScope, credentialId, credential });
      },
    ),
    resolve: vi.fn(() => null),
    extractToken: vi.fn(() => null),
    delete: vi.fn(),
  };

  // Build a fake keys file for existing roles
  const keysData: Record<string, any> = {};
  for (const role of opts?.existingRoles ?? []) {
    keysData[role] = {
      value: 'enc:fake',
      expires_ts: 0,
      updated_ts: Date.now(),
    };
  }

  // Write keys file to disk so readKeysFile finds it
  const keysDir = path.join(
    tmpDir,
    '.config',
    'nanoclaw',
    'credentials',
    String(TEST_CRED_SCOPE),
  );
  fs.mkdirSync(keysDir, { recursive: true });
  // Only write if there are existing roles
  if (Object.keys(keysData).length > 0) {
    fs.writeFileSync(
      path.join(keysDir, 'test-provider.keys.json'),
      JSON.stringify(keysData),
    );
  }

  return {
    engine: {
      resolveCredentialScope: vi.fn(() => TEST_CRED_SCOPE),
      getSubstitute: vi.fn(() => opts?.existingSubstitute ?? null),
      storeGroupCredential: vi.fn(
        (
          _groupScope: any,
          providerId: string,
          credentialId: string,
          credential: any,
        ) => {
          stored.push({
            providerId,
            credentialScope: String(_groupScope),
            credentialId,
            credential,
          });
        },
      ),
      clearCredentials: vi.fn(),
      pruneStaleRefs: vi.fn(),
      revokeByScope: vi.fn(() => 2),
    } as any,
    resolver,
    stored,
  };
}

function createChat(
  replies: Array<string | null>,
): ChatIO & { sent: string[] } {
  let replyIndex = 0;
  const sent: string[] = [];
  return {
    sent,
    send: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    sendRaw: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    receive: vi.fn(async () => {
      const reply = replyIndex < replies.length ? replies[replyIndex] : null;
      replyIndex++;
      return reply;
    }),
    hideMessage: vi.fn(),
    advanceCursor: vi.fn(),
  };
}

const PGP_ENCRYPTED = `-----BEGIN PGP MESSAGE-----
hQEMA+fake+encrypted
-----END PGP MESSAGE-----`;

// ---------------------------------------------------------------------------
// isKeyEligibleProvider
// ---------------------------------------------------------------------------

describe('isKeyEligibleProvider', () => {
  beforeEach(() => mockProviders.clear());

  it('returns true for provider with bearer-swap rules', () => {
    mockProviders.set('github', makeProvider('github'));
    expect(isKeyEligibleProvider('github')).toBe(true);
  });

  it('returns false for provider without bearer-swap rules', () => {
    mockProviders.set('nobs', makeProvider('nobs', { bearerSwap: false }));
    expect(isKeyEligibleProvider('nobs')).toBe(false);
  });

  it('returns false for unknown provider', () => {
    expect(isKeyEligibleProvider('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getProviderCredentialIds
// ---------------------------------------------------------------------------

describe('getProviderCredentialIds', () => {
  beforeEach(() => mockProviders.clear());

  it('returns credential IDs from existing keys on disk', () => {
    mockProviders.set('test-provider', makeProvider('test-provider'));
    const { engine } = mockTokenEngine({
      existingRoles: [CRED_OAUTH, 'api_key'],
    });
    const ids = getProviderCredentialIds(
      'test-provider',
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(ids.has(CRED_OAUTH)).toBe(true);
    expect(ids.has('api_key')).toBe(true);
  });

  it('returns credential IDs from envVars', () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH, GITHUB_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine } = mockTokenEngine();
    const ids = getProviderCredentialIds('github', TEST_GROUP_SCOPE, engine);
    expect(ids.has(CRED_OAUTH)).toBe(true);
    expect(ids.has('api_key')).toBe(false);
  });

  it('excludes nested paths from envVars', () => {
    mockProviders.set(
      'test',
      makeProvider('test', {
        envVars: { TOKEN: CRED_OAUTH, REFRESH: CRED_OAUTH_REFRESH },
      }),
    );
    const { engine } = mockTokenEngine();
    const ids = getProviderCredentialIds('test', TEST_GROUP_SCOPE, engine);
    expect(ids.has(CRED_OAUTH)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('returns empty set for unknown provider', () => {
    const { engine } = mockTokenEngine();
    const roles = getProviderCredentialIds('unknown', TEST_GROUP_SCOPE, engine);
    expect(roles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// storeProviderKey
// ---------------------------------------------------------------------------

describe('storeProviderKey', () => {
  beforeEach(() => mockProviders.clear());

  it('clears credentials, stores new key, prunes stale refs', () => {
    mockProviders.set('github', makeProvider('github'));
    const { engine, resolver } = mockTokenEngine();

    storeProviderKey(
      'github',
      TEST_GROUP_SCOPE,
      CRED_OAUTH,
      'my-token',
      0,
      engine,
    );

    expect(engine.clearCredentials).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
    );
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      CRED_OAUTH,
      expect.objectContaining({ value: 'my-token', expires_ts: 0 }),
    );
    expect(engine.pruneStaleRefs).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
    );
  });

  it('returns needsRestart=true when env var has no existing substitute', () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine } = mockTokenEngine({ existingSubstitute: null });

    const result = storeProviderKey(
      'github',
      TEST_GROUP_SCOPE,
      CRED_OAUTH,
      'tok',
      0,
      engine,
    );
    expect(result.needsRestart).toBe(true);
  });

  it('returns needsRestart=false when substitute already existed', () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine } = mockTokenEngine({ existingSubstitute: 'sub-existing' });

    const result = storeProviderKey(
      'github',
      TEST_GROUP_SCOPE,
      CRED_OAUTH,
      'tok',
      0,
      engine,
    );
    expect(result.needsRestart).toBe(false);
  });

  it('returns needsRestart=false when no envVars declared', () => {
    mockProviders.set('github', makeProvider('github'));
    const { engine } = mockTokenEngine();

    const result = storeProviderKey(
      'github',
      TEST_GROUP_SCOPE,
      CRED_OAUTH,
      'tok',
      0,
      engine,
    );
    expect(result.needsRestart).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSetKey
// ---------------------------------------------------------------------------

describe('handleSetKey', () => {
  beforeEach(() => {
    mockProviders.clear();
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    mockGpgAvailable.mockReturnValue(true);
    mockGpgDecrypt.mockReturnValue('decrypted-key');
  });

  it('decrypts PGP and stores key with default role', () => {
    const { engine, resolver } = mockTokenEngine();
    const result = handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
    );

    expect(result).toContain('Key stored');
    expect(result).toContain('github');
    expect(mockGpgDecrypt).toHaveBeenCalled();
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      CRED_OAUTH,
      expect.objectContaining({ value: 'decrypted-key', expires_ts: 0 }),
    );
  });

  it('parses explicit credential ID and expiry', () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH, GH_API_KEY: 'api_key' },
      }),
    );
    const { engine, resolver } = mockTokenEngine();
    const args = `api_key expiry=3600\n${PGP_ENCRYPTED}`;
    handleSetKey('github', args, TEST_GROUP_SCOPE, engine);

    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      'api_key',
      expect.objectContaining({ value: 'decrypted-key', expires_ts: 3600 }),
    );
  });

  it('handles PGP block on the same line', () => {
    const { engine, resolver } = mockTokenEngine();
    const args = `oauth ${PGP_ENCRYPTED}`;
    handleSetKey('github', args, TEST_GROUP_SCOPE, engine);

    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      CRED_OAUTH,
      expect.objectContaining({ value: 'decrypted-key', expires_ts: 0 }),
    );
  });

  it('returns error for missing PGP block', () => {
    const { engine } = mockTokenEngine();
    const result = handleSetKey(
      'github',
      'just plain text',
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(result).toContain('Expected a GPG-encrypted message');
  });

  it('returns error for ineligible provider', () => {
    mockProviders.set('nobs', makeProvider('nobs', { bearerSwap: false }));
    const { engine } = mockTokenEngine();
    const result = handleSetKey(
      'nobs',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(result).toContain('no bearer-swap rules');
  });

  it('returns error when GPG not available', () => {
    mockGpgAvailable.mockReturnValue(false);
    const { engine } = mockTokenEngine();
    const result = handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(result).toContain('GPG is not available');
  });

  it('returns error on decrypt failure', () => {
    mockGpgDecrypt.mockImplementation(() => {
      throw new Error('bad key');
    });
    const { engine } = mockTokenEngine();
    const result = handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(result).toContain('Failed to decrypt');
  });

  it('appends restart notice when needed', () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine } = mockTokenEngine({ existingSubstitute: null });
    const result = handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(result).toContain('restart');
  });

  it('expiry= value is stored as epoch_ms directly', () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine, resolver } = mockTokenEngine();
    const futureMs = Date.now() + 3_600_000;
    const args = `oauth expiry=${futureMs}\n${PGP_ENCRYPTED}`;
    handleSetKey('github', args, TEST_GROUP_SCOPE, engine);

    const storeCall = engine.storeGroupCredential.mock.calls[0];
    // storeGroupCredential(groupScope, providerId, credentialId, credential)
    const credential = storeCall[3] as { expires_ts: number };
    expect(credential.expires_ts).toBe(futureMs);
  });
});

// ---------------------------------------------------------------------------
// handleDeleteKeys
// ---------------------------------------------------------------------------

describe('handleDeleteKeys', () => {
  beforeEach(() => mockProviders.clear());

  it('revokes credentials and returns confirmation', () => {
    mockProviders.set('github', makeProvider('github'));
    const { engine } = mockTokenEngine();
    const result = handleDeleteKeys('github', TEST_GROUP_SCOPE, engine);
    expect(result).toContain('Credentials deleted');
    expect(result).toContain('github');
    expect(engine.revokeByScope).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
    );
  });

  it('returns error for unknown provider', () => {
    const { engine } = mockTokenEngine();
    const result = handleDeleteKeys('nonexistent', TEST_GROUP_SCOPE, engine);
    expect(result).toContain('Unknown provider');
  });
});

// ---------------------------------------------------------------------------
// runInteractiveKeySetup
// ---------------------------------------------------------------------------

describe('runInteractiveKeySetup', () => {
  beforeEach(() => {
    mockProviders.clear();
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    mockGpgAvailable.mockReturnValue(true);
    mockGpgDecrypt.mockReturnValue('decrypted-key');
  });

  it('sends GPG key raw and stores decrypted key', async () => {
    const { engine, resolver } = mockTokenEngine();
    const chat = createChat(['1', PGP_ENCRYPTED]);

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );

    expect(result).toBe(true);
    expect(chat.sendRaw).toHaveBeenCalled();
    const rawMsg = (chat.sendRaw as any).mock.calls[0][0];
    expect(rawMsg).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      CRED_OAUTH,
      expect.objectContaining({ value: 'decrypted-key', expires_ts: 0 }),
    );
  });

  it('returns false for ineligible provider', async () => {
    mockProviders.set('nobs', makeProvider('nobs', { bearerSwap: false }));
    const { engine } = mockTokenEngine();
    const chat = createChat([]);

    const result = await runInteractiveKeySetup(
      'nobs',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('no bearer-swap rules'))).toBe(
      true,
    );
  });

  it('returns false when user cancels credential selection', async () => {
    // Provider with bearer-swap but no envVars and no existing keys
    mockProviders.set('bare', makeProvider('bare'));
    const { engine } = mockTokenEngine();
    const chat = createChat(['0']); // cancel

    const result = await runInteractiveKeySetup(
      'bare',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('Cancelled'))).toBe(true);
  });

  it('asks user to choose when multiple roles', async () => {
    mockProviders.set(
      'multi',
      makeProvider('multi', {
        envVars: { KEY: 'api_key', TOKEN: CRED_OAUTH },
      }),
    );
    const { engine, resolver } = mockTokenEngine();
    // Reply "1" to role selection, then PGP block
    const chat = createChat(['1', PGP_ENCRYPTED]);

    const result = await runInteractiveKeySetup(
      'multi',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(true);
    // Menu should have been shown with numbered choices
    expect(chat.sent.some((m) => m.includes('1.'))).toBe(true);
  });

  it('returns false on cancel reply', async () => {
    const { engine } = mockTokenEngine();
    const chat = createChat(['0']); // cancel at credential selection

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
  });

  it('returns false when GPG not available', async () => {
    mockGpgAvailable.mockReturnValue(false);
    const { engine } = mockTokenEngine();
    const chat = createChat(['1']); // select credential, then GPG fails

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('GPG is not installed'))).toBe(
      true,
    );
  });

  it('returns false on non-PGP reply', async () => {
    const { engine } = mockTokenEngine();
    const chat = createChat(['1', 'plain-text-key']);

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
    expect(
      chat.sent.some((m) => m.includes('Expected a GPG-encrypted message')),
    ).toBe(true);
  });

  it('returns false on decrypt failure', async () => {
    mockGpgDecrypt.mockImplementation(() => {
      throw new Error('bad');
    });
    const { engine } = mockTokenEngine();
    const chat = createChat(['1', PGP_ENCRYPTED]);

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('Failed to decrypt'))).toBe(true);
  });

  it('hides message and advances cursor after receiving reply', async () => {
    const { engine } = mockTokenEngine();
    const chat = createChat(['1', PGP_ENCRYPTED]);

    await runInteractiveKeySetup('github', TEST_GROUP_SCOPE, engine, chat);
    expect(chat.hideMessage).toHaveBeenCalled();
    expect(chat.advanceCursor).toHaveBeenCalled();
  });

  it('returns false on timeout', async () => {
    const { engine } = mockTokenEngine();
    const chat = createChat([null]); // timeout

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
  });
});
