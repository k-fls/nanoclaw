/**
 * Built-in commands — registered as a side-effect when this module is imported.
 */

import { startRemoteControl, stopRemoteControl } from '../remote-control.js';
import { reply } from './helpers.js';
import { registerCommand, getAllCommands } from './registry.js';

registerCommand('stop', {
  description: 'Stop the running agent',
  run(_args, { containerName }) {
    if (!containerName) {
      return reply('No agent running.');
    }
    return { stopContainer: true, ...reply('Stopping agent.') };
  },
});

registerCommand('help', {
  description: 'Show available commands',
  run(_args, ctx) {
    const lines = [...getAllCommands().entries()]
      .filter(([, cmd]) => !cmd.access || cmd.access(ctx) === null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, cmd]) => `/${name} — ${cmd.description}`);
    return reply(lines.join('\n\n'));
  },
});

registerCommand('remote-control', {
  description: 'Start a Claude Code remote control session',
  access: (ctx) =>
    ctx.group.isMain ? null : '/remote-control is only available in the main group.',
  run(_args, ctx) {
    return {
      asyncAction: async (io) => {
        const result = await startRemoteControl(
          ctx.sender,
          ctx.chatJid,
          process.cwd(),
        );
        if (result.ok) {
          await io.send(result.url);
        } else {
          await io.send(`Remote Control failed: ${result.error}`);
        }
      },
    };
  },
});

registerCommand('remote-control-end', {
  description: 'End the active remote control session',
  access: (ctx) =>
    ctx.group.isMain ? null : '/remote-control-end is only available in the main group.',
  run() {
    return {
      asyncAction: async (io) => {
        const result = stopRemoteControl();
        if (result.ok) {
          await io.send('Remote Control session ended.');
        } else {
          await io.send(result.error);
        }
      },
    };
  },
});
