import type { CommandResult } from './types.js';

/** Shorthand for a result that just sends a message. */
export function reply(text: string): CommandResult {
  return { asyncAction: async (io) => { await io.send(text); } };
}
