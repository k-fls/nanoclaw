import { describe, it, expect } from 'vitest';
import { parseCommand, extractCommand, handleCommand } from './commands.js';
import type { NewMessage } from './types.js';

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
    it('stops active container', () => {
      const result = handleCommand('stop', '', true);
      expect(result.stopContainer).toBe(true);
      expect(result.reply).toMatch(/stopping/i);
    });

    it('reports no container when inactive', () => {
      const result = handleCommand('stop', '', false);
      expect(result.stopContainer).toBeUndefined();
      expect(result.reply).toMatch(/no agent/i);
    });
  });

  describe('/auth', () => {
    it('stops container and triggers reauth when active', () => {
      const result = handleCommand('auth', '', true);
      expect(result.stopContainer).toBe(true);
      expect(result.runReauth).toBe(true);
    });

    it('triggers reauth without stop when no container', () => {
      const result = handleCommand('auth', '', false);
      expect(result.stopContainer).toBeFalsy();
      expect(result.runReauth).toBe(true);
    });
  });

  describe('/help', () => {
    it('lists all commands with descriptions', () => {
      const result = handleCommand('help', '', false);
      expect(result.reply).toContain('/stop');
      expect(result.reply).toContain('/auth');
      expect(result.reply).toContain('/help');
    });
  });

  describe('unknown command', () => {
    it('returns error with help hint', () => {
      const result = handleCommand('foobar', '', true);
      expect(result.reply).toContain('/foobar');
      expect(result.reply).toContain('/help');
      expect(result.stopContainer).toBeUndefined();
      expect(result.runReauth).toBeUndefined();
    });
  });
});
