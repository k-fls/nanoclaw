/**
 * User-facing /command handling.
 *
 * Commands are intercepted after trigger detection, before the agent.
 * The handler is pure logic — returns a result that the caller acts on.
 */

import { TRIGGER_PATTERN } from './config.js';
import { getProxy } from './credential-proxy.js';
import {
  createTapFilter,
  getActiveTap,
  clearActiveTap,
  LOG_FILE,
} from './proxy-tap-logger.js';
import {
  startRemoteControl,
  stopRemoteControl,
  getActiveSession,
} from './remote-control.js';
import {
  hasSubscriptionCredential,
  PROVIDER_ID as CLAUDE_PROVIDER_ID,
} from './auth/providers/claude.js';
import type { TokenSubstituteEngine } from './auth/token-substitute.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import { scopeOf } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** If set, caller should stop the container before proceeding */
  stopContainer?: boolean;
  /** If set, caller should run reauth after stopping */
  runReauth?: boolean;
  /** Async action — returned string (if any) is sent as a message */
  asyncAction?: () => Promise<string | undefined>;
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
// Access helpers
// ---------------------------------------------------------------------------

/**
 * True if the group has a Claude subscription credential (OAuth access token)
 * in its own credential scope. Resolves the effective scope via the token engine.
 */
function canRemoteControl(
  group: RegisteredGroup,
  tokenEngine: TokenSubstituteEngine,
): boolean {
  if (group.isMain) return true;
  const credScope = tokenEngine.resolveCredentialScope(
    scopeOf(group),
    CLAUDE_PROVIDER_ID,
  );
  return (
    String(credScope) === group.folder && hasSubscriptionCredential(credScope)
  );
}

/** Shorthand for a result that just sends a message. */
function reply(text: string): CommandResult {
  return { asyncAction: async () => text };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const COMMAND_RE = /^\/([a-zA-Z0-9-]+)(?:\s+(.*))?$/;

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

interface CommandRunContext {
  hasActiveContainer: boolean;
  group: RegisteredGroup;
  tokenEngine: TokenSubstituteEngine;
  chatJid: string;
  sender: string;
}

interface Command {
  description: string;
  mainOnly?: boolean;
  /** Custom access check. Return a rejection message, or null to allow. */
  access?: (ctx: CommandRunContext) => string | null;
  run: (args: string, ctx: CommandRunContext) => CommandResult;
}

const commands: Record<string, Command> = {
  stop: {
    description: 'Stop the running agent',
    run(_args, { hasActiveContainer }) {
      if (!hasActiveContainer) {
        return reply('No agent running.');
      }
      return { stopContainer: true, ...reply('Stopping agent.') };
    },
  },

  auth: {
    description: 'Stop agent and re-authenticate',
    run(_args, { hasActiveContainer }) {
      return {
        stopContainer: hasActiveContainer,
        runReauth: true,
      };
    },
  },

  tap: {
    description:
      'Manage proxy tap logger — /tap <domain> <path> | /tap stop | /tap',
    mainOnly: true,
    run(args) {
      // /tap (no args) — show current state
      if (!args) {
        const active = getActiveTap();
        if (!active) return reply('Tap is not active.');
        return reply(
          `Tap active — domain: ${active.domain}, path: ${active.path}\nLog: ${LOG_FILE}`,
        );
      }

      // /tap stop — disable
      if (args === 'stop') {
        getProxy().setTapFilter(null);
        clearActiveTap();
        return reply('Tap stopped.');
      }

      // /tap <domain> <path> — enable
      const parts = args.split(/\s+/);
      if (parts.length < 2) {
        return reply(
          'Usage: /tap <domain-regex> <path-regex>\nExample: /tap anthropic\\.com /v1/messages',
        );
      }
      const [domain, pathPattern] = parts;
      try {
        const filter = createTapFilter(
          new RegExp(domain),
          new RegExp(pathPattern),
          LOG_FILE,
        );
        getProxy().setTapFilter(filter);
        return reply(
          `Tap started — domain: ${domain}, path: ${pathPattern}\nLog: ${LOG_FILE}`,
        );
      } catch (e) {
        return reply(`Invalid regex: ${e instanceof Error ? e.message : e}`);
      }
    },
  },

  'remote-control': {
    description: 'Start a host-level Claude Code remote session',
    access(ctx) {
      if (!canRemoteControl(ctx.group, ctx.tokenEngine)) {
        return "Remote control requires a Claude subscription in this group's own credential scope.";
      }
      return null;
    },
    run(_args, { chatJid, sender }) {
      const session = getActiveSession();
      if (session) {
        return reply(`Remote Control already active: ${session.url}`);
      }
      return {
        asyncAction: async () => {
          const result = await startRemoteControl(
            sender,
            chatJid,
            process.cwd(),
          );
          return result.ok
            ? result.url
            : `Remote Control failed: ${result.error}`;
        },
      };
    },
  },

  'remote-control-end': {
    description: 'Stop the active remote control session',
    access(ctx) {
      if (!canRemoteControl(ctx.group, ctx.tokenEngine)) {
        return "Remote control requires a Claude subscription in this group's own credential scope.";
      }
      return null;
    },
    run() {
      const result = stopRemoteControl();
      return reply(result.ok ? 'Remote Control session ended.' : result.error);
    },
  },

  help: {
    description: 'Show available commands',
    run() {
      const lines = Object.entries(commands)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, cmd]) => `/${name} — ${cmd.description}`);
      return reply(lines.join('\n\n'));
    },
  },
};

/**
 * Handle a parsed command.
 * Returns a CommandResult that the caller acts on.
 */
export function handleCommand(
  name: string,
  args: string,
  runCtx: CommandRunContext,
): CommandResult {
  const cmd = commands[name];
  if (!cmd) {
    return reply(
      `Unknown command: /${name}\nType /help for available commands.`,
    );
  }
  if (cmd.mainOnly && !runCtx.group.isMain) {
    return reply(`/${name} is only available in the main group.`);
  }
  if (cmd.access) {
    const rejection = cmd.access(runCtx);
    if (rejection) return reply(rejection);
  }
  return cmd.run(args, runCtx);
}

// ---------------------------------------------------------------------------
// Execution — wires command result to side effects
// ---------------------------------------------------------------------------

export interface CommandContext {
  group: RegisteredGroup;
  tokenEngine: TokenSubstituteEngine;
  chatJid: string;
  sender: string;
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
  const extracted = extractCommand(messages, ctx.group.isMain === true);
  if (!extracted) return false;

  const { cmd, message: cmdMsg } = extracted;
  ctx.hideMessage(cmdMsg.id);
  ctx.advanceCursor(messages[messages.length - 1].timestamp);

  const lastMsg = messages[messages.length - 1];
  const result = handleCommand(cmd.name, cmd.args, {
    hasActiveContainer: ctx.isActive(),
    group: ctx.group,
    tokenEngine: ctx.tokenEngine,
    chatJid: ctx.chatJid,
    sender: lastMsg.sender,
  });
  if (result.stopContainer) ctx.closeStdin();
  if (result.asyncAction) {
    const msg = await result.asyncAction();
    if (msg) await ctx.sendMessage(msg);
  }
  if (result.runReauth) await ctx.runReauth();
  return true;
}
