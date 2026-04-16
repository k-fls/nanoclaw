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
import { brandChat } from './chat-io.js';
import { logger } from '../logger.js';

// ── InteractionAbortedError ─────────────────────────────────────────

/** Thrown when handler code accesses a revoked context (container stopped). */
export class InteractionAbortedError extends Error {
  constructor() {
    super('Interaction session stopped');
    this.name = 'InteractionAbortedError';
  }
}

// ── Handler context ─────────────────────────────────────────────────

/**
 * Context passed to every interaction handler.
 *
 * Handlers MUST access properties at each step (no destructuring) so
 * that revocation is detected immediately.
 */
export interface HandlerContext {
  readonly chat: ChatIO;
  readonly queue: InteractionQueue;
  readonly statusRegistry: InteractionStatusRegistry;
}

/**
 * Create a revocable HandlerContext. Accessing any property after
 * `revoke()` throws InteractionAbortedError.
 */
export function createHandlerContext(
  chat: ChatIO,
  queue: InteractionQueue,
  statusRegistry: InteractionStatusRegistry,
): { ctx: HandlerContext; revoke: () => void } {
  let revoked = false;
  const check = () => {
    if (revoked) throw new InteractionAbortedError();
  };
  return {
    ctx: {
      get chat() {
        check();
        return chat;
      },
      get queue() {
        check();
        return queue;
      },
      get statusRegistry() {
        check();
        return statusRegistry;
      },
    },
    revoke() {
      revoked = true;
    },
  };
}

// ── Handler registry ────────────────────────────────────────────────

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
 *
 * @param queue   Direct ref for loop mechanics (waitForEntry) — not through ctx.
 * @param ctx     Revocable context passed to handlers.
 */
export async function consumeInteractions(
  queue: InteractionQueue,
  chatLock: AsyncMutex,
  ctx: HandlerContext,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const entry: InteractionEntry | null = await queue.waitForEntry(signal);
    if (!entry) break;

    await chatLock.acquire();
    try {
      const handler = handlers.get(entry.eventType) ?? defaultHandler;
      await handler(entry, ctx);
    } catch (err) {
      if (!(err instanceof InteractionAbortedError)) {
        try {
          ctx.statusRegistry.emit(
            entry.interactionId,
            entry.eventType,
            'failed',
            `error: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          /* ctx revoked between throw and here — skip status update */
        }
        logger.error(
          { interactionId: entry.interactionId, err },
          'Interaction processing error',
        );
      }
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
  const chat = brandChat(ctx.chat, '');

  ctx.statusRegistry.emit(
    entry.interactionId,
    entry.eventType,
    'active',
    'presenting to user',
  );

  // Notification-only: no reply expected
  if (!entry.replyFn) {
    await chat.send(
      `*${entry.sourceId}* ${entry.eventType}\n${entry.eventParam}` +
        (entry.eventUrl ? `\n${entry.eventUrl}` : ''),
    );
    ctx.statusRegistry.emit(
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
    `*${entry.sourceId}* needs input.`,
    entry.eventParam,
    entry.eventUrl,
    'Reply when ready, or *0* to cancel.',
  ].filter(Boolean);
  await chat.send(parts.join('\n'));

  let done = false;
  while (!done) {
    const timeoutMs = 10 * 60 * 1000; // 10 minutes
    const reply = await chat.receive(timeoutMs);

    if (!reply || reply.trim() === '0') {
      chat.hideMessage();
      chat.advanceCursor();
      ctx.statusRegistry.emit(
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
      ctx.statusRegistry.emit(
        entry.interactionId,
        entry.eventType,
        'completed',
        result.response ?? 'done',
      );
      await chat.send(
        `*${entry.sourceId}* completed.` +
          (result.response ? ` ${result.response}` : ''),
      );
      logger.info(
        { interactionId: entry.interactionId },
        'Interaction completed successfully',
      );
    } else {
      // Not done — show response and prompt again
      await chat.send(result.response ?? 'Please try again.');
    }
  }
}
