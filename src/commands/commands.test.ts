import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, extractCommand, handleCommand } from './index.js';
import { ASSISTANT_NAME } from '../config.js';
import type { NewMessage, RegisteredGroup } from '../types.js';
import type { ChatIO } from '../interaction/types.js';

// Mock remote-control module for /remote-control tests
const mockStartRemoteControl = vi.fn();
const mockStopRemoteControl = vi.fn();
vi.mock('../remote-control.js', () => ({
  startRemoteControl: (...args: unknown[]) => mockStartRemoteControl(...args),
  stopRemoteControl: (...args: unknown[]) => mockStopRemoteControl(...args),
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
    containerName: hasActiveContainer ? 'nanoclaw-test-1234567890' : null,
    group,
    chatJid: 'test@g.us',
    sender: 'user@s.whatsapp.net',
  };
}

function mockIO(): ChatIO {
  return {
    send: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
    sendRaw: vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    receive: vi
      .fn<(timeoutMs?: number) => Promise<string | null>>()
      .mockResolvedValue(null),
    hideMessage: vi.fn(),
    advanceCursor: vi.fn(),
  };
}

async function replyText(result: {
  asyncAction?: (io: ChatIO) => Promise<void>;
}): Promise<string | undefined> {
  if (!result.asyncAction) return undefined;
  const io = mockIO();
  await result.asyncAction(io);
  const calls = (io.send as ReturnType<typeof vi.fn>).mock.calls;
  return calls.length > 0 ? (calls[0][0] as string) : undefined;
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
    const result = extractCommand(messages, mainGroup);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('stop');
    expect(result!.message).toBe(messages[1]);
  });

  it('returns null for main group when last message is not a command', () => {
    const messages = [msg('/stop'), msg('hello')];
    expect(extractCommand(messages, mainGroup)).toBeNull();
  });

  it('extracts command from trigger message in non-main group', () => {
    const messages = [msg('context'), msg(`@${ASSISTANT_NAME} /stop`)];
    const result = extractCommand(messages, otherGroup);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('stop');
    expect(result!.message).toBe(messages[1]);
  });

  it('returns null for non-main group without trigger', () => {
    const messages = [msg('/stop')];
    expect(extractCommand(messages, otherGroup)).toBeNull();
  });

  it('returns null for empty messages', () => {
    expect(extractCommand([], mainGroup)).toBeNull();
    expect(extractCommand([], otherGroup)).toBeNull();
  });

  it('returns null when trigger message is not a command', () => {
    const messages = [msg(`@${ASSISTANT_NAME} hello`)];
    expect(extractCommand(messages, otherGroup)).toBeNull();
  });

  it('extracts command after Slack bot mention is decoded to trigger', () => {
    const messages = [msg(`@${ASSISTANT_NAME} /auth`)];
    const result = extractCommand(messages, otherGroup);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('auth');
  });

  it('extracts command with args after decoded bot mention', () => {
    const messages = [msg(`@${ASSISTANT_NAME} /auth claude`)];
    const result = extractCommand(messages, otherGroup);
    expect(result).not.toBeNull();
    expect(result!.cmd.name).toBe('auth');
    expect(result!.cmd.args).toBe('claude');
  });

  it('fails when raw Slack encoding is not decoded', () => {
    const messages = [msg('<@U0AKKG67T7X> /auth')];
    expect(extractCommand(messages, otherGroup)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleCommand — /stop
// ---------------------------------------------------------------------------

describe('handleCommand', () => {
  describe('/stop', () => {
    it('stops active container', async () => {
      const result = handleCommand('stop', '', runCtx(true));
      expect(result.stopContainer).toBe(true);
      expect(await replyText(result)).toMatch(/stopping/i);
    });

    it('reports no container when inactive', async () => {
      const result = handleCommand('stop', '', runCtx(false));
      expect(result.stopContainer).toBeUndefined();
      expect(await replyText(result)).toMatch(/no agent/i);
    });
  });

  // ---------------------------------------------------------------------------
  // /help
  // ---------------------------------------------------------------------------

  describe('/help', () => {
    it('lists all commands with descriptions', async () => {
      const result = handleCommand('help', '', runCtx(false));
      const text = await replyText(result);
      expect(text).toContain('/stop');
      expect(text).toContain('/help');
      expect(text).toContain('/remote-control');
      expect(text).toContain('/remote-control-end');
    });

    it('hides access-restricted commands from non-main groups', async () => {
      const result = handleCommand('help', '', runCtx(false, otherGroup));
      const text = await replyText(result);
      expect(text).toContain('/stop');
      expect(text).toContain('/help');
      expect(text).not.toContain('/remote-control');
    });
  });

  // ---------------------------------------------------------------------------
  // /remote-control
  // ---------------------------------------------------------------------------

  describe('/remote-control', () => {
    beforeEach(() => {
      mockStartRemoteControl.mockReset();
      mockStopRemoteControl.mockReset();
    });

    it('rejects from non-main group', async () => {
      const result = handleCommand(
        'remote-control',
        '',
        runCtx(false, otherGroup),
      );
      const text = await replyText(result);
      expect(text).toMatch(/main group/i);
    });

    it('sends URL on success', async () => {
      mockStartRemoteControl.mockResolvedValue({
        ok: true,
        url: 'https://claude.ai/code/test',
      });
      const result = handleCommand('remote-control', '', runCtx(false));
      const io = mockIO();
      await result.asyncAction!(io);
      expect(io.send).toHaveBeenCalledWith('https://claude.ai/code/test');
    });

    it('sends error on failure', async () => {
      mockStartRemoteControl.mockResolvedValue({
        ok: false,
        error: 'spawn failed',
      });
      const result = handleCommand('remote-control', '', runCtx(false));
      const io = mockIO();
      await result.asyncAction!(io);
      expect(io.send).toHaveBeenCalledWith(
        expect.stringContaining('spawn failed'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // /remote-control-end
  // ---------------------------------------------------------------------------

  describe('/remote-control-end', () => {
    beforeEach(() => {
      mockStopRemoteControl.mockReset();
    });

    it('rejects from non-main group', async () => {
      const result = handleCommand(
        'remote-control-end',
        '',
        runCtx(false, otherGroup),
      );
      const text = await replyText(result);
      expect(text).toMatch(/main group/i);
    });

    it('sends confirmation on success', async () => {
      mockStopRemoteControl.mockReturnValue({ ok: true });
      const result = handleCommand('remote-control-end', '', runCtx(false));
      const io = mockIO();
      await result.asyncAction!(io);
      expect(io.send).toHaveBeenCalledWith('Remote Control session ended.');
    });

    it('sends error when no session', async () => {
      mockStopRemoteControl.mockReturnValue({
        ok: false,
        error: 'No active Remote Control session',
      });
      const result = handleCommand('remote-control-end', '', runCtx(false));
      const io = mockIO();
      await result.asyncAction!(io);
      expect(io.send).toHaveBeenCalledWith('No active Remote Control session');
    });
  });

  // ---------------------------------------------------------------------------
  // unknown command
  // ---------------------------------------------------------------------------

  describe('unknown command', () => {
    it('returns error with help hint', async () => {
      const result = handleCommand('foobar', '', runCtx(true));
      const text = await replyText(result);
      expect(text).toContain('/foobar');
      expect(text).toContain('/help');
      expect(result.stopContainer).toBeUndefined();
    });
  });
});
