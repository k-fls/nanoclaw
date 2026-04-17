/**
 * Auth-related commands — registered as a side-effect when imported.
 */

import { getProxy } from '../auth/credential-proxy.js';
import {
  createTapFilter,
  getActiveTap,
  clearActiveTap,
  readTapLog,
  LOG_FILE,
} from '../auth/proxy-tap-logger.js';
import {
  parseTapExclude,
  getDiscoveryProvider,
  getAllDiscoveryProviderIds,
} from '../auth/registry.js';
import {
  hasSubscriptionCredential,
  PROVIDER_ID as CLAUDE_PROVIDER_ID,
} from '../auth/providers/claude.js';
import { handleSetKey, handleDeleteKeys, handleImport } from '../auth/key-management.js';
import { isGpgAvailable, ensureGpgKey, exportPublicKey } from '../auth/gpg.js';
import { runReauth } from '../auth/reauth.js';
import { getTokenEngine } from '../auth/registry.js';
import { AUTH_PREFIX } from '../auth/chat-prompts.js';
import { brandChat } from '../interaction/chat-io.js';
import { scopeOf } from '../types.js';
import { reply } from './helpers.js';
import { registerCommand } from './registry.js';

registerCommand('auth', {
  description: 'Manage authentication — /auth [provider] [set-key|delete]',
  run(args, ctx) {
    const tokenEngine = getTokenEngine();

    // (a) No args or "claude" → existing reauth
    if (!args || args === CLAUDE_PROVIDER_ID) {
      return {
        stopContainer: true,
        asyncAction: async (io) => {
          const chat = brandChat(io, AUTH_PREFIX);
          await runReauth(
            scopeOf(ctx.group),
            chat,
            'User requested auth',
            CLAUDE_PROVIDER_ID,
            tokenEngine,
          );
        },
      };
    }

    const firstLine = args.split('\n')[0];
    const parts = firstLine.trim().split(/\s+/);
    const providerId = parts[0];
    const subcommand = parts[1]?.toLowerCase();

    // `*` is a bulk-import marker; all other values must be real providers
    if (providerId === '*') {
      if (subcommand !== 'import') {
        return reply('`/auth *` only supports the `import` subcommand.');
      }
    } else if (!getDiscoveryProvider(providerId)) {
      const known = getAllDiscoveryProviderIds();
      return reply(
        `Unknown provider: ${providerId}\n` +
          `Known providers: ${known.join(', ')}`,
      );
    }

    // (d) /auth <provider> delete
    if (subcommand === 'delete') {
      return {
        asyncAction: async (io) => {
          const chat = brandChat(io, AUTH_PREFIX);
          const msg = await handleDeleteKeys(
            providerId,
            scopeOf(ctx.group),
            tokenEngine,
          );
          if (msg) await chat.send(msg);
        },
      };
    }

    // (e) /auth <provider|*> import <pgp block>
    if (subcommand === 'import') {
      const rest = args.slice(args.indexOf('import') + 6).trim();
      const defaultProviderId = providerId === '*' ? null : providerId;
      return {
        asyncAction: async (io) => {
          const chat = brandChat(io, AUTH_PREFIX);
          const msg = await handleImport(
            defaultProviderId,
            rest,
            scopeOf(ctx.group),
            tokenEngine,
            chat,
          );
          if (msg) await chat.send(msg);
        },
      };
    }

    // (c) /auth <provider> set-key [role] [expiry=N] <pgp block>
    if (subcommand === 'set-key') {
      const rest = args.slice(args.indexOf('set-key') + 7).trim();
      return {
        asyncAction: async (io) => {
          const chat = brandChat(io, AUTH_PREFIX);
          const msg = await handleSetKey(
            providerId,
            rest,
            scopeOf(ctx.group),
            tokenEngine,
            chat,
          );
          if (msg) await chat.send(msg);
        },
      };
    }

    // (b) /auth <provider> → interactive key setup (needs ChatIO)
    return {
      asyncAction: async (io) => {
        const chat = brandChat(io, AUTH_PREFIX);
        const { runInteractiveKeySetup } = await import(
          '../auth/key-management.js'
        );
        await runInteractiveKeySetup(
          providerId,
          scopeOf(ctx.group),
          tokenEngine,
          chat,
        );
      },
    };
  },
});

registerCommand('tap', {
  description:
    'Manage proxy tap logger — /tap all [exclude=...] | /tap <domain> <path> | /tap stop | /tap',
  access: (ctx) =>
    ctx.group.isMain ? null : '/tap is only available in the main group.',
  run(args) {
    // /tap (no args) — show current state
    if (!args) {
      const active = getActiveTap();
      if (!active) return reply('Tap is not active.');
      return reply(
        `Tap active — domain: ${active.domain}, path: ${active.path}\nLog: ${LOG_FILE}`,
      );
    }

    // /tap stop — disable
    if (args === 'stop') {
      getProxy().setTapFilter(null);
      clearActiveTap();
      return reply('Tap stopped.');
    }

    // /tap list [head|tail <N>] [body] — show log entries
    if (args === 'list' || args.startsWith('list ')) {
      const listArgs = args.slice(4).trim().split(/\s+/).filter(Boolean);
      let mode: 'head' | 'tail' = 'tail';
      let count = 5;
      const showBody = listArgs.includes('body');
      const filtered = listArgs.filter((a) => a !== 'body');
      if (filtered[0] === 'head' || filtered[0] === 'tail') {
        mode = filtered[0];
        if (filtered[1]) count = parseInt(filtered[1], 10) || 5;
      } else if (filtered[0]) {
        count = parseInt(filtered[0], 10) || 5;
      }
      return reply(readTapLog(mode, count, showBody));
    }

    // /tap all [exclude=provider1,provider2] — tap everything
    // Default: exclude=claude
    if (args === 'all' || args.startsWith('all ')) {
      const allArgs = args.slice(3).trim();
      if (allArgs && !/^exclude=\S*$/.test(allArgs)) {
        return reply('Usage: /tap all [exclude=provider1,provider2]');
      }
      const excludeMatch = allArgs.match(/^exclude=(\S*)$/);
      const { excluded: excludeProviders, unknown } = parseTapExclude(
        excludeMatch ? excludeMatch[1] : undefined,
      );
      if (unknown.length > 0) {
        return reply(`Unknown provider(s): ${unknown.join(', ')}`);
      }

      const filter = createTapFilter(
        new RegExp(''),
        new RegExp(''),
        LOG_FILE,
        excludeProviders,
      );
      getProxy().setTapFilter(filter);
      const excludeLabel =
        excludeProviders.size > 0
          ? `\nExcluding: ${[...excludeProviders].join(', ')}`
          : '';
      return reply(
        `Tap started — all traffic${excludeLabel}\nLog: ${LOG_FILE}`,
      );
    }

    // /tap <domain> <path> — enable
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      return reply(
        'Usage: /tap <domain-regex> <path-regex>\nExample: /tap anthropic\\.com /v1/messages',
      );
    }
    const [domain, pathPattern] = parts;
    try {
      const filter = createTapFilter(
        new RegExp(domain),
        new RegExp(pathPattern),
        LOG_FILE,
      );
      getProxy().setTapFilter(filter);
      return reply(
        `Tap started — domain: ${domain}, path: ${pathPattern}\nLog: ${LOG_FILE}`,
      );
    } catch (e) {
      return reply(`Invalid regex: ${e instanceof Error ? e.message : e}`);
    }
  },
});

registerCommand('auth-gpg', {
  description: 'Print GPG public key for this group',
  run(_args, ctx) {
    if (!isGpgAvailable())
      return reply('GPG is not available. Install gnupg first.');
    const groupScope = scopeOf(ctx.group);
    ensureGpgKey(groupScope);
    return {
      asyncAction: async (io) => {
        await io.sendRaw(exportPublicKey(groupScope));
      },
    };
  },
});
