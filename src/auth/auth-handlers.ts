/**
 * Auth-specific interaction handlers.
 *
 * Registered at startup via registerAuthHandlers(). Handles:
 * - oauth-start: dedup + default interactive flow
 * - device-code: bare code (copyable) + instruction message
 */
import {
  registerInteractionHandler,
  defaultHandler,
  getInteractionPrefix,
  type HandlerContext,
  type InteractionEntry,
} from '../interaction/index.js';
import { logger } from '../logger.js';

/**
 * oauth-start handler: collapse duplicate entries for the same provider
 * (newer supersedes older), then delegate to the default handler.
 */
async function oauthStartHandler(
  entry: InteractionEntry,
  ctx: HandlerContext,
): Promise<void> {
  const pid = entry.sourceId;
  const dupes = ctx.queue.extract(
    (e) => e.eventType === 'oauth-start' && e.sourceId === pid,
    'superseded',
  );
  if (dupes.length > 0) {
    const newest = dupes[dupes.length - 1];
    const reason = `superseded by ${newest.interactionId}`;
    ctx.statusRegistry.emit(
      entry.interactionId,
      entry.eventType,
      'removed',
      reason,
    );
    for (let i = 0; i < dupes.length - 1; i++) {
      ctx.statusRegistry.emit(
        dupes[i].interactionId,
        dupes[i].eventType,
        'removed',
        reason,
      );
    }
    entry = newest;
  }

  await defaultHandler(entry, ctx);
}

/**
 * device-code handler: send bare code (copyable), then instruction with URL.
 * Notification-only — no reply expected.
 */
async function deviceCodeHandler(
  entry: InteractionEntry,
  ctx: HandlerContext,
): Promise<void> {
  const prefix = getInteractionPrefix();
  const { chat, statusRegistry } = ctx;

  statusRegistry.emit(
    entry.interactionId,
    entry.eventType,
    'active',
    'presenting to user',
  );

  // Bare code via sendRaw so user can copy it
  await chat.sendRaw(entry.eventParam);
  await chat.send(
    `${prefix}Copy the code above and open ${entry.eventUrl} to complete authentication.`,
  );

  statusRegistry.emit(
    entry.interactionId,
    entry.eventType,
    'completed',
    'notification delivered (no reply expected)',
  );
  logger.info(
    { interactionId: entry.interactionId },
    'Device code notification delivered',
  );
}

/** Register auth interaction handlers. Called once at startup. */
export function registerAuthHandlers(): void {
  registerInteractionHandler('oauth-start', oauthStartHandler);
  registerInteractionHandler('device-code', deviceCodeHandler);
}
