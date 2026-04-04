/**
 * FIFO interaction queue consumer.
 *
 * Single loop for the lifetime of a session. Acquires chatLock
 * before any chat interaction, processes one entry at a time.
 */
import { AsyncMutex } from './async-mutex.js';
import type {
  InteractionQueue,
  InteractionEntry,
} from './queue.js';
import type { InteractionStatusRegistry } from './status.js';
import type { ChatIO } from './types.js';
import { getInteractionPrefix } from './types.js';
import { logger } from '../logger.js';

/**
 * Run the FIFO consumer loop. Returns when the AbortSignal fires.
 *
 * Processes entries one at a time: acquire lock -> present event -> await reply
 * -> deliver -> release lock. FIFO ordering is structural (queue.waitForEntry
 * pops from front).
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

    await processInteraction(entry, chatLock, chat, statusRegistry, signal);
  }
}

/**
 * Process a single interaction entry. Acquires chatLock, presents event,
 * awaits reply, delivers, releases lock.
 *
 * Exported so callers can process an extracted entry directly
 * without chatLock (post-exit, no contention).
 */
export async function processInteraction(
  entry: InteractionEntry,
  chatLock: AsyncMutex | null,
  chat: ChatIO,
  statusRegistry: InteractionStatusRegistry,
  signal?: AbortSignal,
): Promise<void> {
  const prefix = getInteractionPrefix();

  if (chatLock) {
    await chatLock.acquire();
  }
  try {
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
        await chat.send(
          `${prefix}${result.response ?? 'Please try again.'}`,
        );
      }
    }
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
    if (chatLock) {
      chatLock.release();
    }
  }
}
