/**
 * Command registry — mutable Map with registration and dispatch.
 */

import { reply } from './helpers.js';
import type { Command, CommandResult, CommandRunContext } from './types.js';

const commands = new Map<string, Command>();

export function registerCommand(name: string, cmd: Command): void {
  commands.set(name, cmd);
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name);
}

export function getAllCommands(): ReadonlyMap<string, Command> {
  return commands;
}

/**
 * Handle a parsed command.
 * Returns a CommandResult that the caller acts on.
 */
export function handleCommand(name: string, args: string, runCtx: CommandRunContext): CommandResult {
  const cmd = commands.get(name);
  if (!cmd) {
    return reply(`Unknown command: /${name}\nType /help for available commands.`);
  }
  if (cmd.access) {
    const rejection = cmd.access(runCtx);
    if (rejection) return reply(rejection);
  }
  return cmd.run(args, runCtx);
}
