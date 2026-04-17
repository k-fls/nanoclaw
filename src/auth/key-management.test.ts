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
  handleImport,
  tokenizeImportLines,
  applyProviderEntries,
  renderSummary,
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
      getOrCreateSubstitute: vi.fn(() => 'sub-new'),
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

// ---------------------------------------------------------------------------
// handleImport
// ---------------------------------------------------------------------------

describe('handleImport', () => {
  const chat = createChat([]);

  beforeEach(() => {
    mockProviders.clear();
    mockProviders.set(
      'github',
      makeProvider('github', { envVars: { GH_TOKEN: CRED_OAUTH } }),
    );
    mockProviders.set(
      'slack',
      makeProvider('slack', { envVars: { SLACK_TOKEN: CRED_OAUTH } }),
    );
    mockGpgAvailable.mockReturnValue(true);
    mockPromptGpgEncrypt.mockResolvedValue(null);
  });

  // ── single-provider mode (defaultProviderId set) ────────────────────────

  it('imports plain KEY=VALUE lines for the default provider', async () => {
    mockGpgDecrypt.mockReturnValue('GH_TOKEN=tok1\napi_key=tok2');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 2 credentials for *github*');
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', CRED_OAUTH, // GH_TOKEN → oauth via envVars
      expect.objectContaining({ value: 'tok1' }),
    );
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', 'api_key', // lowercase key stored under its own name
      expect.objectContaining({ value: 'tok2' }),
    );
  });

  it('registers ALL_CAPS keys as env vars but not lowercase keys', async () => {
    mockGpgDecrypt.mockReturnValue('GH_TOKEN=tok1\napi_key=tok2');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Env vars: GH_TOKEN');
    expect(engine.getOrCreateSubstitute).toHaveBeenCalledTimes(1);
  });

  it('accepts matching provider: prefix in single mode', async () => {
    mockGpgDecrypt.mockReturnValue('github:GH_TOKEN=tok1');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 1 credential for *github*');
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', CRED_OAUTH,
      expect.objectContaining({ value: 'tok1' }),
    );
  });

  it('ignores lines with a non-matching provider prefix in single mode', async () => {
    mockGpgDecrypt.mockReturnValue('GH_TOKEN=tok1\nslack:TOKEN=oops');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 1 credential for *github*');
    expect(result).toMatch(/ignored \(slack ≠ github\)/);
    // slack credential was not written
    expect(engine.storeGroupCredential).not.toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'slack', expect.anything(), expect.anything(),
    );
  });

  it('returns "no valid KEY=VALUE" when decrypted payload is empty', async () => {
    mockGpgDecrypt.mockReturnValue('# just a comment\n\n');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('No valid KEY=VALUE pairs');
  });

  it('flags restart when no prior substitute existed', async () => {
    mockGpgDecrypt.mockReturnValue('GH_TOKEN=tok');
    const { engine } = mockTokenEngine({ existingSubstitute: null });
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('restart');
  });

  // ── bulk mode (defaultProviderId = null) ────────────────────────────────

  it('imports entries for multiple providers in bulk mode', async () => {
    mockGpgDecrypt.mockReturnValue(
      'github:GH_TOKEN=tokA\nslack:SLACK_TOKEN=tokB',
    );
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      null, PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 2 credentials across 2 providers');
    expect(result).toContain('*github*: 1 key');
    expect(result).toContain('*slack*: 1 key');
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', CRED_OAUTH,
      expect.objectContaining({ value: 'tokA' }),
    );
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'slack', CRED_OAUTH,
      expect.objectContaining({ value: 'tokB' }),
    );
  });

  it('warns on prefix-less lines in bulk mode', async () => {
    mockGpgDecrypt.mockReturnValue('github:GH_TOKEN=tok\nlonely=x');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      null, PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 1 credential across 1 provider');
    expect(result).toMatch(/no provider: lonely=x/);
  });

  it('reports unknown provider per-bucket in bulk mode', async () => {
    mockGpgDecrypt.mockReturnValue('bogus:KEY=val\ngithub:GH_TOKEN=real');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      null, PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('*bogus*: 0 keys');
    expect(result).toContain('unknown provider');
    expect(result).toContain('*github*: 1 key');
  });

  it('returns "no valid provider:key=value" when bulk payload has nothing usable', async () => {
    mockGpgDecrypt.mockReturnValue('# comment only');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      null, PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('No valid provider:key=value pairs');
  });

  // ── tokenization edge cases surfaced via handleImport ───────────────────

  it('skips comments and blank lines', async () => {
    mockGpgDecrypt.mockReturnValue(
      '# header\n\nGH_TOKEN=tok\n# trailing\n',
    );
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 1 credential');
    expect(engine.storeGroupCredential).toHaveBeenCalledTimes(1);
  });

  it('reports malformed line (no =)', async () => {
    mockGpgDecrypt.mockReturnValue('GH_TOKEN=ok\njustwords');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Imported 1 credential');
    expect(result).toMatch(/malformed: justwords/);
  });

  it('reports empty value (KEY=)', async () => {
    mockGpgDecrypt.mockReturnValue('GH_TOKEN=\napi_key=real');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toMatch(/empty value: GH_TOKEN/);
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', 'api_key',
      expect.objectContaining({ value: 'real' }),
    );
  });

  it('treats colon after = as part of the value, not a prefix', async () => {
    mockGpgDecrypt.mockReturnValue('api_key=host:port:segment');
    const { engine } = mockTokenEngine();
    await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', 'api_key',
      expect.objectContaining({ value: 'host:port:segment' }),
    );
  });

  // ── decrypt / prompt paths ──────────────────────────────────────────────

  it('falls through to promptGpgEncrypt when no inline PGP block', async () => {
    mockPromptGpgEncrypt.mockResolvedValue('GH_TOKEN=tok');
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', 'no pgp here', TEST_GROUP_SCOPE, engine, chat,
    );
    expect(mockPromptGpgEncrypt).toHaveBeenCalled();
    expect(result).toContain('Imported 1 credential');
  });

  it('returns null when promptGpgEncrypt is cancelled', async () => {
    mockPromptGpgEncrypt.mockResolvedValue(null);
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      null, 'just text', TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toBeNull();
  });

  it('returns error on decrypt failure', async () => {
    mockGpgDecrypt.mockImplementation(() => {
      throw new Error('bad key');
    });
    const { engine } = mockTokenEngine();
    const result = await handleImport(
      'github', PGP_ENCRYPTED, TEST_GROUP_SCOPE, engine, chat,
    );
    expect(result).toContain('Failed to decrypt');
  });
});

// ---------------------------------------------------------------------------
// tokenizeImportLines — pure syntactic split, no validation
// ---------------------------------------------------------------------------

describe('tokenizeImportLines', () => {
  it('skips blank and comment lines', () => {
    const t = tokenizeImportLines('# hello\n\n  \n# another');
    expect(t.size).toBe(0);
  });

  it('groups prefix-less lines under the null key', () => {
    const t = tokenizeImportLines('FOO=bar\nBAZ=qux');
    expect(t.get(null)?.get('FOO')).toBe('bar');
    expect(t.get(null)?.get('BAZ')).toBe('qux');
    expect(t.size).toBe(1);
  });

  it('groups prefixed lines under their provider', () => {
    const t = tokenizeImportLines('github:GH=x\nslack:S=y\ngithub:OTHER=z');
    expect(t.get('github')?.get('GH')).toBe('x');
    expect(t.get('github')?.get('OTHER')).toBe('z');
    expect(t.get('slack')?.get('S')).toBe('y');
    expect(t.size).toBe(2);
  });

  it('recognizes prefix only when ":" precedes the first "="', () => {
    const t = tokenizeImportLines('api_key=host:port:seg');
    expect(t.get(null)?.get('api_key')).toBe('host:port:seg');
    expect(t.get('api_key')).toBeUndefined();
  });

  it('stores null value when "=" is missing (no validation)', () => {
    const t = tokenizeImportLines('FOO\ngithub:BAR');
    expect(t.get(null)?.has('FOO')).toBe(true);
    expect(t.get(null)?.get('FOO')).toBeNull();
    expect(t.get('github')?.get('BAR')).toBeNull();
  });

  it('preserves empty value when line ends with "="', () => {
    const t = tokenizeImportLines('FOO=');
    expect(t.get(null)?.get('FOO')).toBe('');
  });

  it('last-write-wins for duplicate keys in the same bucket', () => {
    const t = tokenizeImportLines('FOO=first\nFOO=second');
    expect(t.get(null)?.get('FOO')).toBe('second');
  });

  it('trims whitespace around prefix, key, and value', () => {
    const t = tokenizeImportLines('  github  :  GH_TOKEN  =  tok  ');
    expect(t.get('github')?.get('GH_TOKEN')).toBe('tok');
  });
});

// ---------------------------------------------------------------------------
// applyProviderEntries
// ---------------------------------------------------------------------------

describe('applyProviderEntries', () => {
  beforeEach(() => {
    mockProviders.clear();
    mockProviders.set(
      'github',
      makeProvider('github', { envVars: { GH_TOKEN: CRED_OAUTH } }),
    );
  });

  it('returns zero-count with warning for unknown provider', () => {
    const { engine } = mockTokenEngine();
    const r = applyProviderEntries(
      'nonexistent',
      new Map([['KEY', 'val']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(r.count).toBe(0);
    expect(r.warnings).toContain('unknown provider');
    expect(engine.storeGroupCredential).not.toHaveBeenCalled();
  });

  it('returns zero-count with warning for non-eligible provider', () => {
    mockProviders.set('nobs', makeProvider('nobs', { bearerSwap: false }));
    const { engine } = mockTokenEngine();
    const r = applyProviderEntries(
      'nobs',
      new Map([['KEY', 'val']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(r.count).toBe(0);
    expect(r.warnings).toContain('no bearer-swap rules');
    expect(engine.storeGroupCredential).not.toHaveBeenCalled();
  });

  it('stores each entry and counts them', () => {
    const { engine } = mockTokenEngine();
    const r = applyProviderEntries(
      'github',
      new Map([['GH_TOKEN', 'tokA'], ['api_key', 'tokB']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(r.count).toBe(2);
    expect(r.providerId).toBe('github');
    expect(engine.storeGroupCredential).toHaveBeenCalledTimes(2);
  });

  it('maps ALL_CAPS env-var keys to their declared credential path', () => {
    const { engine } = mockTokenEngine();
    applyProviderEntries(
      'github',
      new Map([['GH_TOKEN', 'tok']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    // GH_TOKEN maps to CRED_OAUTH via envVars
    expect(engine.storeGroupCredential).toHaveBeenCalledWith(
      TEST_GROUP_SCOPE, 'github', CRED_OAUTH,
      expect.objectContaining({ value: 'tok' }),
    );
  });

  it('registers ALL_CAPS keys as env-var substitutes', () => {
    const { engine } = mockTokenEngine();
    const r = applyProviderEntries(
      'github',
      new Map([['GH_TOKEN', 'tok']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(r.envVars).toEqual(['GH_TOKEN']);
    expect(engine.getOrCreateSubstitute).toHaveBeenCalled();
  });

  it('does not register lowercase keys as env vars', () => {
    const { engine } = mockTokenEngine();
    const r = applyProviderEntries(
      'github',
      new Map([['api_key', 'tok']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(r.envVars).toEqual([]);
    expect(engine.getOrCreateSubstitute).not.toHaveBeenCalled();
  });

  it('propagates needsRestart=true when any key needs restart', () => {
    const { engine } = mockTokenEngine({ existingSubstitute: null });
    const r = applyProviderEntries(
      'github',
      new Map([['GH_TOKEN', 'tok']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    expect(r.needsRestart).toBe(true);
  });

  it('warns and does not register env var when substitute creation fails (null)', () => {
    const { engine } = mockTokenEngine();
    (engine.getOrCreateSubstitute as any).mockReturnValue(null);
    const r = applyProviderEntries(
      'github',
      new Map([['GH_TOKEN', 'short']]),
      TEST_GROUP_SCOPE,
      engine,
    );
    // Credential was stored (import always persists the file).
    expect(engine.storeGroupCredential).toHaveBeenCalledTimes(1);
    // But no env var registered — access is blocked until config is fixed.
    expect(r.envVars).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/GH_TOKEN/);
    expect(r.warnings[0]).toMatch(/too short/);
    expect(r.warnings[0]).toMatch(/_token_format/);
  });
});

// ---------------------------------------------------------------------------
// renderSummary
// ---------------------------------------------------------------------------

describe('renderSummary', () => {
  const success = (id: string, count: number, envVars: string[] = []): any => ({
    providerId: id, count, envVars, warnings: [], needsRestart: false,
  });

  it('single-provider: reports count + env vars', () => {
    const out = renderSummary(
      [success('github', 2, ['GH_TOKEN'])],
      false,
      [],
    );
    expect(out).toContain('Imported 2 credentials for *github*');
    expect(out).toContain('Env vars: GH_TOKEN');
  });

  it('single-provider: singular form when count is 1', () => {
    const out = renderSummary([success('github', 1)], false, []);
    expect(out).toContain('Imported 1 credential for *github*');
  });

  it('bulk: aggregates total + per-provider breakdown', () => {
    const out = renderSummary(
      [success('github', 2, ['GH_TOKEN']), success('slack', 1)],
      true,
      [],
    );
    expect(out).toContain('Imported 3 credentials across 2 providers');
    expect(out).toContain('*github*: 2 keys');
    expect(out).toContain('env: GH_TOKEN');
    expect(out).toContain('*slack*: 1 key');
  });

  it('bulk: excludes zero-count providers from "successful" count', () => {
    const out = renderSummary(
      [
        { providerId: 'bogus', count: 0, envVars: [], warnings: ['unknown provider'], needsRestart: false },
        success('github', 1),
      ],
      true,
      [],
    );
    expect(out).toContain('Imported 1 credential across 1 provider');
    expect(out).toContain('*bogus*: 0 keys');
    expect(out).toContain('warn: unknown provider');
  });

  it('appends skipped-line section when line warnings are present', () => {
    const out = renderSummary(
      [success('github', 1)],
      false,
      ['malformed: foo', 'empty value: BAR'],
    );
    expect(out).toContain('Skipped lines:');
    expect(out).toContain('- malformed: foo');
    expect(out).toContain('- empty value: BAR');
  });

  it('appends restart notice when any result flags it', () => {
    const out = renderSummary(
      [{ ...success('github', 1), needsRestart: true }],
      false,
      [],
    );
    expect(out).toContain('restart');
  });

  it('omits restart notice when nothing needs it', () => {
    const out = renderSummary([success('github', 1)], false, []);
    expect(out).not.toContain('restart');
  });
});
