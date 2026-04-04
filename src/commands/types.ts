/**
 * Core types for the command framework.
 */

import type { NewMessage, RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// CommandIO — minimal IO interface for command actions
// ---------------------------------------------------------------------------

export interface CommandIO {
  send(text: string): Promise<void>;
  sendRaw(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Command result and parsing types
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** If set, caller should stop the container before proceeding. */
  stopContainer?: boolean;
  /** Async action — receives IO for messaging. */
  asyncAction?: (io: CommandIO) => Promise<void>;
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
  getContainerName: () => string | null;
  hideMessage: (msgId: string) => void;
  advanceCursor: (timestamp: string) => void;
  stopContainer: () => void;
  sendMessage: (text: string) => Promise<void>;
  /** Optional — branches provide richer IO (e.g. ChatIO with receive). */
  createIO?: () => CommandIO;
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
