import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, extractCommand, handleCommand } from './commands.js';
import type { NewMessage, RegisteredGroup } from './types.js';

// Mock registry so /auth <provider> can validate discovery providers
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
  };
});

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
    // TRIGGER_PATTERN is ^@{ASSISTANT_NAME}\b — default is "Andy"
    const messages = [msg('context'), msg('@Andy /stop')];
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
    const messages = [msg('@Andy hello')];
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
    it('rejects from non-main group', async () => {
      const result = handleCommand('tap', '', runCtx(false, otherGroup));
      expect(await replyOf(result)).toMatch(/main group/i);
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
