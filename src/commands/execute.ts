/**
 * Command execution — wires extraction, handling, and side-effect dispatch.
 */

import type { NewMessage } from '../types.js';
import { extractCommand } from './parse.js';
import { handleCommand } from './registry.js';
import type { CommandContext, CommandIO } from './types.js';

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
    containerName: ctx.getContainerName(),
    group: ctx.group,
    chatJid: ctx.chatJid,
    sender: lastMsg.sender,
  });

  if (result.stopContainer) ctx.stopContainer();
  if (result.asyncAction) {
    const io: CommandIO = ctx.createIO?.() ?? {
      send: (text) => ctx.sendMessage(text),
      sendRaw: (text) => ctx.sendMessage(text),
    };
    await result.asyncAction(io);
  }
  return true;
}
