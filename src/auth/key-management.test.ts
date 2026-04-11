import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { asGroupScope, asCredentialScope, CRED_OAUTH, CRED_OAUTH_REFRESH } from './oauth-types.js';
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
const mockPromptGpgEncrypt = vi.fn().mockResolvedValue('decrypted-key');
vi.mock('./gpg.js', () => ({
  isGpgAvailable: () => mockGpgAvailable(),
  ensureGpgKey: mockEnsureGpgKey,
  gpgDecrypt: mockGpgDecrypt,
  isPgpMessage: (text: string) => text.includes('-----BEGIN PGP MESSAGE-----'),
  normalizeArmoredBlock: (block: string) => block.trim(),
  promptGpgEncrypt: mockPromptGpgEncrypt,
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
        (_groupScope: any, providerId: string, credentialId: string, credential: any) => {
          stored.push({ providerId, credentialScope: String(_groupScope), credentialId, credential });
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
    const ids = getProviderCredentialIds('test-provider', TEST_GROUP_SCOPE, engine);
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
  const chat = createChat([]);

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
    mockPromptGpgEncrypt.mockResolvedValue('decrypted-key');
  });

  it('decrypts PGP and stores key with default role', async () => {
    const { engine } = mockTokenEngine();
    const result = await handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
      chat,
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

  it('parses explicit credential ID and expiry', async () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH, GH_API_KEY: 'api_key' },
      }),
    );
    const { engine } = mockTokenEngine();
    const args = `api_key expiry=3600\n${PGP_ENCRYPTED}`;
    await handleSetKey('github', args, TEST_GROUP_SCOPE, engine, chat);

    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      'api_key',
      expect.objectContaining({ value: 'decrypted-key', expires_ts: 3600 }),
    );
  });

  it('handles PGP block on the same line', async () => {
    const { engine } = mockTokenEngine();
    const args = `oauth ${PGP_ENCRYPTED}`;
    await handleSetKey('github', args, TEST_GROUP_SCOPE, engine, chat);

    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE,
      'github',
      CRED_OAUTH,
      expect.objectContaining({ value: 'decrypted-key', expires_ts: 0 }),
    );
  });

  it('falls through to promptGpgEncrypt when no PGP block', async () => {
    const { engine } = mockTokenEngine();
    const result = await handleSetKey(
      'github',
      'just plain text',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(mockPromptGpgEncrypt).toHaveBeenCalled();
    expect(result).toContain('Key stored');
  });

  it('returns null when promptGpgEncrypt is cancelled', async () => {
    mockPromptGpgEncrypt.mockResolvedValue(null);
    const { engine } = mockTokenEngine();
    const result = await handleSetKey(
      'github',
      'no pgp here',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBeNull();
  });

  it('returns error for ineligible provider', async () => {
    mockProviders.set('nobs', makeProvider('nobs', { bearerSwap: false }));
    const { engine } = mockTokenEngine();
    const result = await handleSetKey(
      'nobs',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toContain('no bearer-swap rules');
  });

  it('returns error when GPG not available', async () => {
    mockGpgAvailable.mockReturnValue(false);
    const { engine } = mockTokenEngine();
    const result = await handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toContain('GPG is not available');
  });

  it('returns error on decrypt failure', async () => {
    mockGpgDecrypt.mockImplementation(() => {
      throw new Error('bad key');
    });
    const { engine } = mockTokenEngine();
    const result = await handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toContain('Failed to decrypt');
  });

  it('appends restart notice when needed', async () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine } = mockTokenEngine({ existingSubstitute: null });
    const result = await handleSetKey(
      'github',
      PGP_ENCRYPTED,
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toContain('restart');
  });

  it('expiry= value is stored as epoch_ms directly', async () => {
    mockProviders.set(
      'github',
      makeProvider('github', {
        envVars: { GH_TOKEN: CRED_OAUTH },
      }),
    );
    const { engine } = mockTokenEngine();
    const futureMs = Date.now() + 3_600_000;
    const args = `oauth expiry=${futureMs}\n${PGP_ENCRYPTED}`;
    await handleSetKey('github', args, TEST_GROUP_SCOPE, engine, chat);

    const storeCall = engine.storeGroupCredential.mock.calls[0];
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
    mockPromptGpgEncrypt.mockResolvedValue('decrypted-key');
  });

  it('stores key when promptGpgEncrypt succeeds', async () => {
    const { engine } = mockTokenEngine();
    const chat = createChat(['1']);

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );

    expect(result).toBe(true);
    expect(mockPromptGpgEncrypt).toHaveBeenCalled();
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
    const { engine } = mockTokenEngine();
    const chat = createChat(['1']);

    const result = await runInteractiveKeySetup(
      'multi',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(true);
    expect(chat.sent.some((m) => m.includes('1.'))).toBe(true);
  });

  it('returns false when promptGpgEncrypt returns null', async () => {
    mockPromptGpgEncrypt.mockResolvedValue(null);
    const { engine } = mockTokenEngine();
    const chat = createChat(['1']);

    const result = await runInteractiveKeySetup(
      'github',
      TEST_GROUP_SCOPE,
      engine,
      chat,
    );
    expect(result).toBe(false);
  });
});
