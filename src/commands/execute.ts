/**
 * Command execution — wires extraction, handling, and side-effect dispatch.
 */

import type { NewMessage } from '../types.js';
import { extractCommand } from './parse.js';
import { handleCommand } from './registry.js';
import type { CommandContext } from './types.js';

/**
 * Check for a command in messages and execute it.
 * Returns true if a command was handled, false if no command found.
 * Caller is responsible for advancing the message cursor on true.
 */
export async function executeCommand(
  messages: NewMessage[],
  ctx: CommandContext,
): Promise<boolean> {
  const extracted = extractCommand(messages, ctx.group);
  if (!extracted) return false;

  const lastMsg = messages[messages.length - 1];
  const result = handleCommand(extracted.cmd.name, extracted.cmd.args, {
    containerName: ctx.getContainerName(),
    group: ctx.group,
    chatJid: ctx.chatJid,
    sender: lastMsg.sender,
  });

  if (result.stopContainer) ctx.stopContainer();
  if (result.asyncAction) {
    try {
      await result.asyncAction(ctx.chat);
    } catch (err) {
      await ctx.chat.send(
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return true;
}
