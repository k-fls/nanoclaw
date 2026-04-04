/**
 * FIFO interaction queue consumer with handler dispatch.
 *
 * Single loop for the lifetime of a session. Acquires chatLock before
 * dispatching each entry to the registered handler for its event type.
 * Skills register handlers at startup; unhandled types use the default
 * handler (present → receive → deliver).
 */
import { AsyncMutex } from './async-mutex.js';
import type { InteractionQueue, InteractionEntry } from './queue.js';
import type { InteractionEventKind } from './queue.js';
import type { InteractionStatusRegistry } from './status.js';
import type { ChatIO } from './types.js';
import { getInteractionPrefix } from './types.js';
import { logger } from '../logger.js';

// ── Handler registry ────────────────────────────────────────────────

/** Context passed to every interaction handler. */
export interface HandlerContext {
  chat: ChatIO;
  queue: InteractionQueue;
  statusRegistry: InteractionStatusRegistry;
  signal?: AbortSignal;
}

/** Per-event-type handler. Runs inside the chatLock — must not acquire it. */
export type InteractionHandler = (
  entry: InteractionEntry,
  ctx: HandlerContext,
) => Promise<void>;

const handlers = new Map<InteractionEventKind, InteractionHandler>();

/** Register a handler for a specific event type. Replaces any existing handler. */
export function registerInteractionHandler(
  eventType: InteractionEventKind,
  handler: InteractionHandler,
): void {
  handlers.set(eventType, handler);
}

// ── Consumer loop ───────────────────────────────────────────────────

/**
 * Run the FIFO consumer loop. Returns when the AbortSignal fires.
 *
 * Pops entries one at a time, acquires chatLock, dispatches to the
 * registered handler (or defaultHandler), releases lock.
 */
export async function consumeInteractions(
  queue: InteractionQueue,
  chatLock: AsyncMutex,
  chat: ChatIO,
  statusRegistry: InteractionStatusRegistry,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const entry: InteractionEntry | null = await queue.waitForEntry(signal);
    if (!entry) break;

    await chatLock.acquire();
    try {
      const handler = handlers.get(entry.eventType) ?? defaultHandler;
      await handler(entry, { chat, queue, statusRegistry, signal });
    } catch (err) {
      statusRegistry.emit(
        entry.interactionId,
        entry.eventType,
        'failed',
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
      logger.error(
        { interactionId: entry.interactionId, err },
        'Interaction processing error',
      );
    } finally {
      chatLock.release();
    }
  }
}

// ── Default handler ─────────────────────────────────────────────────

/**
 * Default handler: present event to user, collect reply, deliver.
 *
 * Also exported as `processInteraction` for standalone use (e.g.
 * processing an extracted entry outside the consumer loop).
 * When called standalone, the caller is responsible for locking.
 */
export async function defaultHandler(
  entry: InteractionEntry,
  ctx: HandlerContext,
): Promise<void> {
  const { chat, statusRegistry, signal } = ctx;
  const prefix = getInteractionPrefix();

  statusRegistry.emit(
    entry.interactionId,
    entry.eventType,
    'active',
    'presenting to user',
  );

  // Notification-only: no reply expected
  if (!entry.replyFn) {
    await chat.send(
      `${prefix}*${entry.sourceId}* ${entry.eventType}\n${entry.eventParam}` +
        (entry.eventUrl ? `\n${entry.eventUrl}` : ''),
    );
    statusRegistry.emit(
      entry.interactionId,
      entry.eventType,
      'completed',
      'notification delivered (no reply expected)',
    );
    logger.info(
      { interactionId: entry.interactionId },
      'Interaction completed (notification-only)',
    );
    return;
  }

  // Interactive: present and collect reply, loop until done
  const parts = [
    `${prefix}*${entry.sourceId}* needs input.`,
    entry.eventParam,
    entry.eventUrl,
    'Reply when ready, or "cancel" to stop.',
  ].filter(Boolean);
  await chat.send(parts.join('\n'));

  let done = false;
  while (!done) {
    const timeoutMs = 10 * 60 * 1000; // 10 minutes
    const reply = await chat.receive(timeoutMs);

    if (signal?.aborted) {
      statusRegistry.emit(
        entry.interactionId,
        entry.eventType,
        'failed',
        'consumer cancelled (container exited)',
      );
      return;
    }

    if (!reply || reply.trim().toLowerCase() === 'cancel') {
      chat.hideMessage();
      chat.advanceCursor();
      statusRegistry.emit(
        entry.interactionId,
        entry.eventType,
        'failed',
        'user cancelled',
      );
      logger.info(
        { interactionId: entry.interactionId },
        'Interaction cancelled by user',
      );
      return;
    }

    chat.hideMessage();
    chat.advanceCursor();

    const result = await entry.replyFn(reply.trim());
    done = result.done;

    if (done) {
      statusRegistry.emit(
        entry.interactionId,
        entry.eventType,
        'completed',
        result.response ?? 'done',
      );
      await chat.send(
        `${prefix}*${entry.sourceId}* completed.` +
          (result.response ? ` ${result.response}` : ''),
      );
      logger.info(
        { interactionId: entry.interactionId },
        'Interaction completed successfully',
      );
    } else {
      // Not done — show response and prompt again
      await chat.send(`${prefix}${result.response ?? 'Please try again.'}`);
    }
  }
}
