/**
 * /claude-version command — check version and manage updates.
 * Main group only.
 *
 * Usage:
 *   /claude-version                    — show current version and update setting
 *   /claude-version update now         — trigger update with current setting
 *   /claude-version update every 24h  — set periodic update to latest
 *   /claude-version update 24h        — same as above (every is optional)
 *   /claude-version set 2.1.92        — pin and install specific version
 */
import { parseClaudeCliUpdate } from '../config.js';
import {
  getActiveSetting,
  installedVersion,
  reconfigure,
  runUpdate,
} from '../claude-updater/updater.js';
import { reply } from './helpers.js';
import { registerCommand } from './registry.js';

function formatStatus(): string {
  const version = installedVersion();
  const setting = getActiveSetting();
  const config = parseClaudeCliUpdate(setting);

  const lines = [
    `*Claude CLI*`,
    `Version: ${version ?? 'not installed (using image-baked)'}`,
    `Setting: ${setting || '(off)'}`,
  ];

  if (config.mode === 'latest') {
    lines.push(`Mode: latest (every ${setting})`);
  } else if (config.mode === 'pinned') {
    lines.push(`Mode: pinned to ${config.version}`);
  } else {
    lines.push('Mode: off');
  }

  return lines.join('\n');
}

const USAGE =
  'Usage: /claude-version [update [now | [every] <period>] | set <version>]';

registerCommand('claude-version', {
  description: 'Show Claude CLI version and manage updates',
  access: (ctx) =>
    ctx.group.isMain
      ? null
      : '/claude-version is only available in the main group.',
  run(args) {
    const trimmed = args.trim();

    // /claude-version — show status
    if (!trimmed) {
      return reply(formatStatus());
    }

    // /claude-version set <version> — pin to specific version and install
    if (trimmed.startsWith('set ')) {
      const version = trimmed.slice(4).trim();
      const parsed = parseClaudeCliUpdate(version);
      if (parsed.mode !== 'pinned') {
        return reply(
          `Invalid version: ${version}\nExpected a version number like 2.1.92.`,
        );
      }
      reconfigure(version);
      return {
        asyncAction: async (io) => {
          await io.send(`Installing Claude CLI ${version}...`);
          const ok = await runUpdate();
          const installed = installedVersion();
          await io.send(
            ok
              ? `Installed. Version: ${installed}`
              : 'Install failed. Check logs for details.',
          );
        },
      };
    }

    // Must start with "update"
    if (!trimmed.startsWith('update')) {
      return reply(USAGE);
    }

    const updateArgs = trimmed.slice('update'.length).trim();

    // /claude-version update OR /claude-version update now — trigger update
    if (!updateArgs || updateArgs === 'now') {
      const setting = getActiveSetting();
      if (!setting) {
        return reply('No update setting configured.\n' + USAGE);
      }
      return {
        asyncAction: async (io) => {
          await io.send('Updating Claude CLI...');
          const ok = await runUpdate();
          const version = installedVersion();
          await io.send(
            ok
              ? `Update complete. Version: ${version}`
              : 'Update failed. Check logs for details.',
          );
        },
      };
    }

    // /claude-version update [every] <period> — set periodic update
    const period = updateArgs.replace(/^every\s+/, '');
    const parsed = parseClaudeCliUpdate(period);
    if (parsed.mode !== 'latest') {
      return reply(
        `Invalid period: ${period}\nExpected a duration like 24h, 1d, or 30m.`,
      );
    }
    reconfigure(period);
    return reply(
      `Update setting changed to: every ${period}\n\n${formatStatus()}`,
    );
  },
});
