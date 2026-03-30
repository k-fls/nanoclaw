/**
 * User-facing /command handling.
 *
 * Commands are intercepted after trigger detection, before the agent.
 * The handler is pure logic — returns a result that the caller acts on.
 */

import { TRIGGER_PATTERN } from './config.js';
import type { NewMessage } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** If set, caller should stop the container before proceeding */
  stopContainer?: boolean;
  /** If set, caller should run reauth after stopping */
  runReauth?: boolean;
  /** Message to send back to the user */
  reply?: string;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export interface ExtractedCommand {
  cmd: ParsedCommand;
  /** The message that contained the command (for hiding) */
  message: NewMessage;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const COMMAND_RE = /^\/([a-zA-Z0-9]+)(?:\s+(.*))?$/;

/**
 * Parse a command from text content. Returns null if not a command.
 * Expects trigger prefix to already be stripped.
 */
export function parseCommand(content: string): ParsedCommand | null {
  const match = COMMAND_RE.exec(content.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/**
 * Extract a command from a batch of messages.
 * For non-main groups: finds the trigger message, strips trigger, checks for command.
 * For main group: checks the last message directly.
 */
export function extractCommand(
  messages: NewMessage[],
  isMainGroup: boolean,
): ExtractedCommand | null {
  if (messages.length === 0) return null;

  if (isMainGroup) {
    const last = messages[messages.length - 1];
    const cmd = parseCommand(last.content.trim());
    if (cmd) return { cmd, message: last };
    return null;
  }

  // Non-main: find the trigger message and strip the trigger prefix
  const triggerMsg = messages.find((m) =>
    TRIGGER_PATTERN.test(m.content.trim()),
  );
  if (!triggerMsg) return null;

  const afterTrigger = triggerMsg.content
    .trim()
    .replace(TRIGGER_PATTERN, '')
    .trim();
  const cmd = parseCommand(afterTrigger);
  if (cmd) return { cmd, message: triggerMsg };
  return null;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

interface Command {
  description: string;
  run: (args: string, hasActiveContainer: boolean) => CommandResult;
}

const commands: Record<string, Command> = {
  stop: {
    description: 'Stop the running agent',
    run(_args, hasActiveContainer) {
      if (!hasActiveContainer) {
        return { reply: 'No agent running.' };
      }
      return { stopContainer: true, reply: 'Stopping agent.' };
    },
  },

  auth: {
    description: 'Stop agent and re-authenticate',
    run(_args, hasActiveContainer) {
      return {
        stopContainer: hasActiveContainer,
        runReauth: true,
      };
    },
  },

  help: {
    description: 'Show available commands',
    run() {
      const lines = Object.entries(commands)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, cmd]) => `/${name} — ${cmd.description}`);
      return { reply: lines.join('\n\n') };
    },
  },
};

/**
 * Handle a parsed command. Pure logic — no side effects.
 * Returns a CommandResult that the caller acts on.
 */
export function handleCommand(
  name: string,
  args: string,
  hasActiveContainer: boolean,
): CommandResult {
  const cmd = commands[name];
  if (!cmd) {
    return {
      reply: `Unknown command: /${name}\nType /help for available commands.`,
    };
  }
  return cmd.run(args, hasActiveContainer);
}

// ---------------------------------------------------------------------------
// Execution — wires command result to side effects
// ---------------------------------------------------------------------------

export interface CommandContext {
  isMainGroup: boolean;
  isActive: () => boolean;
  hideMessage: (msgId: string) => void;
  advanceCursor: (timestamp: string) => void;
  closeStdin: () => void;
  sendMessage: (text: string) => Promise<void>;
  runReauth: () => Promise<void>;
}

/**
 * Check for a command in messages and execute it.
 * Returns true if a command was handled, false if no command found.
 */
export async function executeCommand(
  messages: NewMessage[],
  ctx: CommandContext,
): Promise<boolean> {
  const extracted = extractCommand(messages, ctx.isMainGroup);
  if (!extracted) return false;

  const { cmd, message: cmdMsg } = extracted;
  ctx.hideMessage(cmdMsg.id);
  ctx.advanceCursor(messages[messages.length - 1].timestamp);

  const result = handleCommand(cmd.name, cmd.args, ctx.isActive());
  if (result.stopContainer) ctx.closeStdin();
  if (result.reply) await ctx.sendMessage(result.reply);
  if (result.runReauth) await ctx.runReauth();
  return true;
}
