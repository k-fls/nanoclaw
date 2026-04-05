/**
 * Command framework — public API.
 *
 * Importing this module registers the built-in commands (/stop, /help,
 * /remote-control, /remote-control-end) as a side-effect.
 */

// Side-effect: register built-in commands
import './builtins.js';
import './auth-commands.js';

export type {
  Command,
  CommandContext,
  CommandResult,
  CommandRunContext,
  ExtractedCommand,
  ParsedCommand,
} from './types.js';
export { parseCommand, extractCommand } from './parse.js';
export {
  registerCommand,
  getCommand,
  getAllCommands,
  handleCommand,
} from './registry.js';
export { executeCommand } from './execute.js';
export { reply } from './helpers.js';
