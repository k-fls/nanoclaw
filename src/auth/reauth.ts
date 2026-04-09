/**
 * Reauth orchestrator — generic, no per-service knowledge.
 * Builds a menu from all registered providers, runs selected option,
 * stores result via the owning provider.
 */
import { logger } from '../logger.js';
import { getAllProviders } from './registry.js';
import { startExecInContainer, authSessionDir } from './exec.js';
import type { CredentialScope, GroupScope } from './oauth-types.js';
import type {
  AuthContext,
  AuthExecOpts,
  AuthOption,
  ChatIO,
  ExecContainerResult,
} from './types.js';
import { RESELECT } from './types.js';
import { chooseOption } from './chat-prompts.js';

/**
 * Run the interactive reauth flow for a given scope.
 * Returns true if credentials were successfully obtained.
 */
export async function runReauth(
  groupScope: GroupScope,
  chat: ChatIO,
  reason: string,
  providerHint: string,
  engine: import('./token-substitute.js').TokenSubstituteEngine,
): Promise<boolean> {
  const providers = getAllProviders();
  const allOptions: AuthOption[] = [];

  for (const provider of providers) {
    const credScope = engine.resolveCredentialScope(groupScope, provider.id);
    allOptions.push(...provider.authOptions(credScope));
  }

  if (allOptions.length === 0) {
    await chat.send(`No auth providers registered.`);
    return false;
  }

  // Loop: providers can return RESELECT to restart the menu
  // (e.g. missing prerequisite). The menu has Cancel + timeout to exit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await showMenuAndRun(
      groupScope,
      chat,
      reason,
      allOptions,
      providerHint,
      engine,
    );
    if (result === 'reselect') continue;
    return result;
  }
}

/** Show the menu, run the selected option. Returns true/false or 'reselect' to restart. */
async function showMenuAndRun(
  groupScope: GroupScope,
  chat: ChatIO,
  reason: string,
  allOptions: AuthOption[],
  providerHint: string,
  engine: import('./token-substitute.js').TokenSubstituteEngine,
): Promise<boolean | 'reselect'> {
  const DELETE_CHOICE = 99;

  // Build choices map: 1..N for auth options, 99 for delete
  const choices = new Map<number, string>();
  for (let i = 0; i < allOptions.length; i++) {
    const opt = allOptions[i];
    let label = `*${opt.label}*`;
    if (opt.description) label += `\n   ${opt.description}`;
    choices.set(i + 1, label);
  }
  choices.set(DELETE_CHOICE, 'Delete credentials');

  const heading = [
    `*Authentication required for ${providerHint}*`,
    ``,
    `Group: *${groupScope}*`,
    `Reason: ${reason}`,
  ].join('\n');

  const choice = await chooseOption(chat, heading, choices, 'an authentication method');

  if (choice === null) {
    await chat.send('Cancelled.');
    return false;
  }

  if (typeof choice === 'string') {
    await chat.send('Please pick a number from the list.');
    return 'reselect';
  }

  if (choice === DELETE_CHOICE) {
    const providers = getAllProviders();
    for (const provider of providers) {
      engine.revokeByScope(groupScope, provider.id);
    }
    await chat.send(
      `Credentials deleted for scope *${groupScope}*.`,
    );
    logger.info({ groupScope }, 'Credentials deleted via reauth menu');
    return false;
  }

  const selected = allOptions[choice - 1];
  const sessionDir = authSessionDir(selected.credentialScope as string);

  const ctx: AuthContext = {
    scope: selected.credentialScope,
    startExec(command: string[], opts?: AuthExecOpts): ExecContainerResult {
      return startExecInContainer(command, sessionDir, {
        mounts: opts?.mounts,
        credentialScope: selected.credentialScope,
      });
    },
    chat,
  };

  try {
    const result = await selected.run(ctx);
    // Advance cursor past any messages the provider read (OAuth code, etc.)
    // so they don't leak to the agent as regular messages.
    chat.advanceCursor();
    if (result === RESELECT) return 'reselect';
    if (!result) {
      await chat.send(`Auth flow cancelled or failed.`);
      return false;
    }

    selected.provider.storeResult(selected.credentialScope, result, engine);
    await chat.send(
      `Credentials stored for ${selected.provider.displayName}.`,
    );
    logger.info(
      { groupScope, provider: selected.provider.id },
      'Reauth completed',
    );
    return true;
  } catch (err) {
    // Advance cursor even on error to prevent message leakage
    chat.advanceCursor();
    logger.error(
      { groupScope, provider: selected.provider.id, err },
      'Reauth flow error',
    );
    await chat.send(
      `Auth flow error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

