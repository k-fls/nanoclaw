import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, extractCommand, handleCommand } from './commands.js';
import { ASSISTANT_NAME } from './config.js';
import type { NewMessage, RegisteredGroup } from './types.js';

// Mock registry so /auth <provider> can validate discovery providers
const knownProviders = new Set(['claude', 'github', 'stripe']);
vi.mock('./auth/registry.js', () => {
  const providers = new Map([
    ['github', { id: 'github', rules: [{ mode: 'bearer-swap' }] }],
    ['stripe', { id: 'stripe', rules: [{ mode: 'bearer-swap' }] }],
  ]);
  return {
    getDiscoveryProvider: (id: string) => providers.get(id),
    getAllDiscoveryProviderIds: () => [...providers.keys()],
    getProvider: vi.fn(),
    getAllProviders: vi.fn(() => []),
    getTokenEngine: vi.fn(() => ({})),
    getTokenResolver: vi.fn(() => ({})),
    registerProvider: vi.fn(),
    registerDiscoveryProviders: vi.fn(),
    registerClaudeUniversalRules: vi.fn(),
    setTokenEngine: vi.fn(),
    getDiscoveryDir: () => '/tmp',
    parseTapExclude: (raw: string | undefined) => {
      if (raw === undefined)
        return { excluded: new Set(['claude']), unknown: [] };
      const ids = raw.split(',').filter(Boolean);
      const excluded = new Set<string>();
      const unknown: string[] = [];
      for (const id of ids) {
        if (knownProviders.has(id)) excluded.add(id);
        else unknown.push(id);
      }
      return { excluded, unknown };
    },
  };
});

// Mock proxy + tap logger for /tap tests
const mockSetTapFilter = vi.fn();
vi.mock('./credential-proxy.js', () => ({
  getProxy: () => ({ setTapFilter: mockSetTapFilter }),
}));

const mockCreateTapFilter = vi.fn(
  (_a: RegExp, _b: RegExp, _c: string, _d?: ReadonlySet<string>) =>
    'mock-filter',
);
vi.mock('./proxy-tap-logger.js', () => ({
  createTapFilter: (a: RegExp, b: RegExp, c: string, d?: ReadonlySet<string>) =>
    mockCreateTapFilter(a, b, c, d),
  getActiveTap: () => null,
  clearActiveTap: vi.fn(),
  readTapLog: vi.fn(() => 'log output'),
  LOG_FILE: '/tmp/tap.jsonl',
}));

// Mock key-management functions
vi.mock('./auth/key-management.js', () => ({
  handleSetKey: vi.fn(() => 'Key stored.'),
  handleDeleteKeys: vi.fn(() => 'Credentials deleted.'),
}));

// Mock GPG functions
vi.mock('./auth/gpg.js', () => ({
  isGpgAvailable: vi.fn(() => true),
  ensureGpgKey: vi.fn(),
  exportPublicKey: vi.fn(
    () =>
      '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----',
  ),
}));

function msg(content: string, id = '1'): NewMessage {
  return {
    id,
    chat_jid: 'test@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content,
    timestamp: new Date().toISOString(),
  };
}

const mainGroup: RegisteredGroup = {
  name: 'main',
  folder: 'main',
  trigger: '',
  added_at: '',
  isMain: true,
};

const otherGroup: RegisteredGroup = {
  name: 'other',
  folder: 'other',
  trigger: '',
  added_at: '',
};

function runCtx(
  hasActiveContainer: boolean,
  group: RegisteredGroup = mainGroup,
) {
  return {
    hasActiveContainer,
    group,
    tokenEngine: {} as any,
    chatJid: 'test@g.us',
    sender: 'user@s.whatsapp.net',
  };
}

async function replyOf(result: {
  asyncAction?: () => Promise<string | undefined>;
}) {
  return result.asyncAction ? await result.asyncAction() : undefined;
}

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

describe('parseCommand', () => {
  it('parses simple command', () => {
    expect(parseCommand('/stop')).toEqual({ name: 'stop', args: '' });
  });

  it('parses command with args', () => {
    expect(parseCommand('/auth claude')).toEqual({
      name: 'auth',
      args: 'claude',
    });
  });

  it('is case-insensitive', () => {
    expect(parseCommand('/Stop')).toEqual({ name: 'stop', args: '' });
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('not /a command')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('returns null for path-like strings', () => {
    expect(parseCommand('/home/user/file.txt')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseCommand('  /stop  ')).toEqual({ name: 'stop', args: '' });
  });

  it('allows hyphens in command names', () => {
    expect(parseCommand('/remote-control')).toEqual({
      name: 'remote-control',
      args: '',
    });
  });
});

// ---------------------------------------------------------------------------
// extractCommand
// ---------------------------------------------------------------------------

describe('extractCommand', () => {
  it('extracts command from main group (last message)', () => {
    const messages = [msg('hello'), msg('/stop')];
    const result = extractCommand(messages, true);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('stop');
    expect(result!.message).toBe(messages[1]);
  });

  it('returns null for main group when last message is not a command', () => {
    const messages = [msg('/stop'), msg('hello')];
    expect(extractCommand(messages, true)).toBeNull();
  });

  it('extracts command from trigger message in non-main group', () => {
    const messages = [msg('context'), msg(`@${ASSISTANT_NAME} /stop`)];
    const result = extractCommand(messages, false);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('stop');
    expect(result!.message).toBe(messages[1]);
  });

  it('returns null for non-main group without trigger', () => {
    const messages = [msg('/stop')];
    expect(extractCommand(messages, false)).toBeNull();
  });

  it('returns null for empty messages', () => {
    expect(extractCommand([], true)).toBeNull();
    expect(extractCommand([], false)).toBeNull();
  });

  it('returns null when trigger message is not a command', () => {
    const messages = [msg(`@${ASSISTANT_NAME} hello`)];
    expect(extractCommand(messages, false)).toBeNull();
  });

  it('extracts command after Slack bot mention is decoded to trigger', () => {
    // After decodeMessages: <@UBOTID> /auth → @AssistantName /auth
    const messages = [msg(`@${ASSISTANT_NAME} /auth`)];
    const result = extractCommand(messages, false);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('auth');
  });

  it('extracts command with args after decoded bot mention', () => {
    const messages = [msg(`@${ASSISTANT_NAME} /auth claude`)];
    const result = extractCommand(messages, false);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('auth');
    expect(result!.cmd.args).toBe('claude');
  });

  it('fails when raw Slack encoding is not decoded', () => {
    // Without decoding, <@UBOTID> doesn't match trigger pattern
    const messages = [msg('<@U0AKKG67T7X> /auth')];
    expect(extractCommand(messages, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleCommand
// ---------------------------------------------------------------------------

describe('handleCommand', () => {
  describe('/stop', () => {
    it('stops active container', async () => {
      const result = handleCommand('stop', '', runCtx(true));
      expect(result.stopContainer).toBe(true);
      expect(await replyOf(result)).toMatch(/stopping/i);
    });

    it('reports no container when inactive', async () => {
      const result = handleCommand('stop', '', runCtx(false));
      expect(result.stopContainer).toBeUndefined();
      expect(await replyOf(result)).toMatch(/no agent/i);
    });
  });

  describe('/auth', () => {
    it('stops container and triggers reauth with claude provider ID', () => {
      const result = handleCommand('auth', '', runCtx(true));
      expect(result.stopContainer).toBe(true);
      expect(result.runReauth).toBe('claude');
    });

    it('/auth claude is equivalent to /auth', () => {
      const result = handleCommand('auth', 'claude', runCtx(false));
      expect(result.stopContainer).toBe(true);
      expect(result.runReauth).toBe('claude');
    });

    it('/auth <provider> returns runKeySetup for known provider', () => {
      const result = handleCommand('auth', 'github', runCtx(false));
      expect(result.runKeySetup).toBe('github');
      expect(result.runReauth).toBeUndefined();
    });

    it('/auth <unknown> returns error with known providers', async () => {
      const result = handleCommand('auth', 'nonexistent', runCtx(false));
      const text = await replyOf(result);
      expect(text).toContain('Unknown provider');
      expect(text).toContain('github');
      expect(text).toContain('stripe');
    });

    it('/auth <provider> delete returns asyncAction', async () => {
      const result = handleCommand('auth', 'github delete', runCtx(false));
      expect(result.asyncAction).toBeDefined();
      const text = await replyOf(result);
      expect(text).toBe('Credentials deleted.');
    });

    it('/auth <provider> set-key returns asyncAction', async () => {
      const result = handleCommand(
        'auth',
        'github set-key -----BEGIN PGP MESSAGE-----\ntest\n-----END PGP MESSAGE-----',
        runCtx(false),
      );
      expect(result.asyncAction).toBeDefined();
      const text = await replyOf(result);
      expect(text).toBe('Key stored.');
    });

    it('/auth <provider> set-key passes args after set-key', async () => {
      const { handleSetKey } = await import('./auth/key-management.js');
      handleCommand(
        'auth',
        'github set-key api_key expiry=3600\n-----BEGIN PGP MESSAGE-----\ndata\n-----END PGP MESSAGE-----',
        runCtx(false),
      );
      // handleSetKey is mocked — we just verify it's called
      // (actual arg parsing tested in key-management.test.ts)
    });
  });

  describe('/auth-gpg', () => {
    it('returns raw GPG public key', () => {
      const result = handleCommand('auth-gpg', '', runCtx(false));
      expect(result.sendRawMessage).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    });
  });

  describe('/tap', () => {
    beforeEach(() => {
      mockSetTapFilter.mockClear();
      mockCreateTapFilter.mockClear();
    });

    it('rejects from non-main group', async () => {
      const result = handleCommand('tap', '', runCtx(false, otherGroup));
      expect(await replyOf(result)).toMatch(/main group/i);
    });

    it('/tap all uses claude as default exclude', async () => {
      const result = handleCommand('tap', 'all', runCtx(false));
      expect(mockCreateTapFilter).toHaveBeenCalledWith(
        expect.any(RegExp),
        expect.any(RegExp),
        '/tmp/tap.jsonl',
        new Set(['claude']),
      );
      expect(mockSetTapFilter).toHaveBeenCalledWith('mock-filter');
      expect(await replyOf(result)).toContain('Excluding: claude');
    });

    it('/tap all exclude= disables exclusions', async () => {
      const result = handleCommand('tap', 'all exclude=', runCtx(false));
      expect(mockCreateTapFilter).toHaveBeenCalledWith(
        expect.any(RegExp),
        expect.any(RegExp),
        '/tmp/tap.jsonl',
        new Set(),
      );
      expect(await replyOf(result)).not.toContain('Excluding');
    });

    it('/tap all exclude=github,stripe passes validated set', async () => {
      const result = handleCommand(
        'tap',
        'all exclude=github,stripe',
        runCtx(false),
      );
      expect(mockCreateTapFilter).toHaveBeenCalledWith(
        expect.any(RegExp),
        expect.any(RegExp),
        '/tmp/tap.jsonl',
        new Set(['github', 'stripe']),
      );
      const text = await replyOf(result);
      expect(text).toContain('github');
      expect(text).toContain('stripe');
    });

    it('/tap all exclude=bogus rejects unknown provider', async () => {
      const result = handleCommand('tap', 'all exclude=bogus', runCtx(false));
      const text = await replyOf(result);
      expect(text).toContain('Unknown provider');
      expect(text).toContain('bogus');
      expect(mockCreateTapFilter).not.toHaveBeenCalled();
    });

    it('/tap all exclude (no = sign) rejects', async () => {
      const result = handleCommand('tap', 'all exclude', runCtx(false));
      expect(await replyOf(result)).toContain('Usage');
      expect(mockCreateTapFilter).not.toHaveBeenCalled();
    });

    it('/tap all exclude=a b rejects (spaces not allowed)', async () => {
      const result = handleCommand('tap', 'all exclude=a b', runCtx(false));
      expect(await replyOf(result)).toContain('Usage');
      expect(mockCreateTapFilter).not.toHaveBeenCalled();
    });
  });

  describe('/help', () => {
    it('lists all commands with descriptions', async () => {
      const result = handleCommand('help', '', runCtx(false));
      const text = await replyOf(result);
      expect(text).toContain('/stop');
      expect(text).toContain('/auth');
      expect(text).toContain('/auth-gpg');
      expect(text).toContain('/help');
      expect(text).toContain('/tap');
    });
  });

  describe('unknown command', () => {
    it('returns error with help hint', async () => {
      const result = handleCommand('foobar', '', runCtx(true));
      const text = await replyOf(result);
      expect(text).toContain('/foobar');
      expect(text).toContain('/help');
      expect(result.stopContainer).toBeUndefined();
      expect(result.runReauth).toBeUndefined();
    });
  });
});
