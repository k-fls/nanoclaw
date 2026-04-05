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
 * Collapse duplicate queued entries for the same eventType + sourceId.
 * Keeps the newest entry and emits 'removed' for the current entry and
 * all older duplicates. Returns the entry to process (unchanged if no dupes).
 */
function dedup(entry: InteractionEntry, ctx: HandlerContext): InteractionEntry {
  const { eventType, sourceId } = entry;
  const dupes = ctx.queue.extract(
    (e) => e.eventType === eventType && e.sourceId === sourceId,
    'superseded',
  );
  if (dupes.length === 0) return entry;

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
  return newest;
}

/**
 * oauth-start handler: collapse duplicate entries for the same provider
 * (newer supersedes older), then delegate to the default handler.
 */
async function oauthStartHandler(
  entry: InteractionEntry,
  ctx: HandlerContext,
): Promise<void> {
  await defaultHandler(dedup(entry, ctx), ctx);
}

/**
 * device-code handler: send bare code (copyable), then instruction with URL.
 * Notification-only — no reply expected.
 */
async function deviceCodeHandler(
  entry: InteractionEntry,
  ctx: HandlerContext,
): Promise<void> {
  entry = dedup(entry, ctx);

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

/** Exported for testing. */
export { dedup as _dedup };

/** Register auth interaction handlers. Called once at startup. */
export function registerAuthHandlers(): void {
  registerInteractionHandler('oauth-start', oauthStartHandler);
  registerInteractionHandler('device-code', deviceCodeHandler);
}
