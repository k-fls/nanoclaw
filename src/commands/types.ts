/**
 * Core types for the command framework.
 */

import type { ChatIO } from '../interaction/types.js';
import type { NewMessage, RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Command result and parsing types
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** If set, caller should stop the container before proceeding. */
  stopContainer?: boolean;
  /** Async action — receives ChatIO for messaging. */
  asyncAction?: (io: ChatIO) => Promise<void>;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export interface ExtractedCommand {
  cmd: ParsedCommand;
  /** The message that contained the command (for hiding). */
  message: NewMessage;
}

// ---------------------------------------------------------------------------
// Contexts passed to command handlers and the execution pipeline
// ---------------------------------------------------------------------------

/** Context passed to individual command handlers. */
export interface CommandRunContext {
  containerName: string | null;
  group: RegisteredGroup;
  chatJid: string;
  sender: string;
  /** Opaque extension data for branch-specific commands. */
  extra?: Record<string, unknown>;
}

/** Context for the full execution pipeline (extract → handle → dispatch). */
export interface CommandContext {
  group: RegisteredGroup;
  chatJid: string;
  sender: string;
  chat: ChatIO;
  getContainerName: () => string | null;
  stopContainer: () => void;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export interface Command {
  description: string;
  /** Access check. Return a rejection message, or null to allow. */
  access?: (ctx: CommandRunContext) => string | null;
  run: (args: string, ctx: CommandRunContext) => CommandResult;
}
