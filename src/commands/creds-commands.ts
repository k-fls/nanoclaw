/**
 * Credential sharing commands — /creds, /creds share, /creds borrow,
 * /creds revoke, /creds stop-borrowing.
 */

import { getAllRegisteredGroups, setRegisteredGroup } from '../db.js';
import { getTokenEngine } from '../auth/registry.js';
import {
  distributeAllManifests,
  revokeGranteeManifests,
  createBorrowedLink,
  removeBorrowedLink,
} from '../auth/manifest.js';
import { scopeOf } from '../types.js';
import { reply } from './helpers.js';
import { registerCommand } from './registry.js';

/** Find a group entry (jid + group) by folder name. */
function findGroupByFolder(folder: string) {
  const all = getAllRegisteredGroups();
  for (const [jid, group] of Object.entries(all)) {
    if (group.folder === folder) return { jid, group };
  }
  return undefined;
}

registerCommand('creds', {
  description:
    'Manage credential sharing — /creds | share <target> | borrow <source> | revoke <target> | stop-borrowing',
  run(args, ctx) {
    if (!args) {
      // Show status
      const group = ctx.group;
      const source = group.containerConfig?.credentialSource;
      const grantees = group.containerConfig?.credentialGrantees ?? new Set<string>();

      const lines: string[] = [`*Credentials for ${group.folder}*`, ''];

      if (source) {
        lines.push(`Borrowing from: *${source}*`);
      } else {
        lines.push('Borrowing from: (none)');
      }

      if (grantees.size > 0) {
        lines.push(`Sharing with: ${[...grantees].map((g) => `*${g}*`).join(', ')}`);
      } else {
        lines.push('Sharing with: (none)');
      }

      return reply(lines.join('\n'));
    }

    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0];
    const target = parts[1];

    switch (subcommand) {
      case 'share': {
        if (!target) return reply('Usage: /creds share <target-group-folder>');

        // Access: must be in main group or the grantor group itself
        if (!ctx.group.isMain) {
          // Non-main: you can only share YOUR OWN scope
          // (which is the current group)
        }

        const targetEntry = findGroupByFolder(target);
        if (!targetEntry) return reply(`Unknown group folder: ${target}`);

        const grantorGroup = ctx.group;
        const grantees =
          grantorGroup.containerConfig?.credentialGrantees ?? new Set<string>();
        if (grantees.has(target))
          return reply(`${target} is already in the grantee list.`);

        // Update grantor's grantee list
        grantees.add(target);
        grantorGroup.containerConfig = {
          ...grantorGroup.containerConfig,
          credentialGrantees: grantees,
        };
        setRegisteredGroup(ctx.chatJid, grantorGroup);

        // Distribute all manifests to new grantee
        distributeAllManifests(grantorGroup.folder, target);

        return reply(
          `Granted *${target}* access to *${grantorGroup.folder}* credentials.\n` +
            `The target group must run \`/creds borrow ${grantorGroup.folder}\` to activate.`,
        );
      }

      case 'borrow': {
        if (!target) return reply('Usage: /creds borrow <source-group-folder>');

        const sourceEntry = findGroupByFolder(target);
        if (!sourceEntry) return reply(`Unknown group folder: ${target}`);

        const borrower = ctx.group;

        // Check if already borrowing from someone else
        if (
          borrower.containerConfig?.credentialSource &&
          borrower.containerConfig.credentialSource !== target
        ) {
          return reply(
            `Already borrowing from *${borrower.containerConfig.credentialSource}*. ` +
              `Run \`/creds stop-borrowing\` first.`,
          );
        }

        // Set credentialSource
        borrower.containerConfig = {
          ...borrower.containerConfig,
          credentialSource: target,
        };
        setRegisteredGroup(ctx.chatJid, borrower);

        // Create borrowed symlink
        createBorrowedLink(borrower.folder, target);

        // Check if grantor has granted
        const sourceGroup = sourceEntry.group;
        const granted =
          sourceGroup.containerConfig?.credentialGrantees?.has(
            borrower.folder,
          ) === true;

        if (granted) {
          // Revoke any stale substitutes and let next container run pick up fresh ones
          const engine = getTokenEngine();
          engine.revokeByScope(scopeOf(borrower));

          return reply(
            `Now borrowing credentials from *${target}*. Active immediately.`,
          );
        } else {
          return reply(
            `Credential source set to *${target}*, but access is *pending* — ` +
              `the source group must run \`/creds share ${borrower.folder}\`.`,
          );
        }
      }

      case 'revoke': {
        if (!target) return reply('Usage: /creds revoke <target-group-folder>');

        // Access: must be in main group or the grantor group
        const grantorGroup = ctx.group;
        const grantees =
          grantorGroup.containerConfig?.credentialGrantees ?? new Set<string>();
        if (!grantees.has(target))
          return reply(`${target} is not in the grantee list.`);

        // Remove from grantee list
        grantees.delete(target);
        grantorGroup.containerConfig = {
          ...grantorGroup.containerConfig,
          credentialGrantees: grantees,
        };
        setRegisteredGroup(ctx.chatJid, grantorGroup);

        // Clean up manifests from grantee
        revokeGranteeManifests(grantorGroup.folder, target);

        // Revoke borrowed substitutes and clear borrower's credentialSource
        const targetEntry = findGroupByFolder(target);
        if (targetEntry) {
          const engine = getTokenEngine();
          engine.revokeByScope(scopeOf(targetEntry.group));

          // Clear the borrower's link back if it points at the revoking grantor
          if (
            targetEntry.group.containerConfig?.credentialSource ===
            grantorGroup.folder
          ) {
            targetEntry.group.containerConfig = {
              ...targetEntry.group.containerConfig,
              credentialSource: undefined,
            };
            setRegisteredGroup(targetEntry.jid, targetEntry.group);
            removeBorrowedLink(target);
          }
        }

        return reply(
          `Revoked *${target}*'s access to *${grantorGroup.folder}* credentials.`,
        );
      }

      case 'stop-borrowing': {
        const borrower = ctx.group;
        const source = borrower.containerConfig?.credentialSource;
        if (!source) return reply('Not borrowing from any group.');

        // Clear credentialSource
        borrower.containerConfig = {
          ...borrower.containerConfig,
          credentialSource: undefined,
        };
        setRegisteredGroup(ctx.chatJid, borrower);

        // Remove borrowed symlink (manifests stay in granted/)
        removeBorrowedLink(borrower.folder);

        // Revoke borrowed substitutes
        const engine = getTokenEngine();
        engine.revokeByScope(scopeOf(borrower));

        return reply(`Stopped borrowing from *${source}*.`);
      }

      default:
        return reply(
          'Unknown subcommand. Usage:\n' +
            '`/creds` — show status\n' +
            '`/creds share <target>` — grant access\n' +
            '`/creds borrow <source>` — borrow credentials\n' +
            '`/creds revoke <target>` — revoke access\n' +
            '`/creds stop-borrowing` — stop borrowing',
        );
    }
  },
});
