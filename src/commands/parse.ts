/**
 * Command parsing and extraction from message batches.
 */

import { getTriggerPattern } from '../config.js';
import type { NewMessage, RegisteredGroup } from '../types.js';
import type { ParsedCommand, ExtractedCommand } from './types.js';

const COMMAND_RE = /^\/([a-zA-Z0-9-]+)(?:\s+([\s\S]*))?$/;

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
export function extractCommand(messages: NewMessage[], group: RegisteredGroup): ExtractedCommand | null {
  if (messages.length === 0) return null;

  if (group.isMain) {
    const last = messages[messages.length - 1];
    const cmd = parseCommand(last.content.trim());
    if (cmd) return { cmd, message: last };
    return null;
  }

  // Non-main: find the trigger message and strip the trigger prefix
  const triggerPattern = getTriggerPattern(group.trigger);
  const triggerMsg = messages.find((m) => triggerPattern.test(m.content.trim()));
  if (!triggerMsg) return null;

  const afterTrigger = triggerMsg.content.trim().replace(triggerPattern, '').trim();
  const cmd = parseCommand(afterTrigger);
  if (cmd) return { cmd, message: triggerMsg };
  return null;
}
