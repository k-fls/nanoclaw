/**
 * FIFO flow queue consumer.
 *
 * Single loop for the lifetime of handleMessages. Acquires chatLock
 * before any chat interaction, processes one flow at a time.
 */
import { AsyncMutex } from './async-mutex.js';
import type { FlowQueue, FlowEntry } from './flow-queue.js';
import type { FlowStatusRegistry } from './flow-status.js';
import type { ChatIO } from './types.js';
import { logger } from '../logger.js';

const FLOW_PREFIX = '🔑🤖 ';

/**
 * Run the FIFO consumer loop. Returns when the AbortSignal fires.
 *
 * Processes flows one at a time: acquire lock → present event → await reply
 * → deliver → release lock. FIFO ordering is structural (queue.waitForEntry
 * pops from front).
 */
export async function consumeFlows(
  queue: FlowQueue,
  chatLock: AsyncMutex,
  chat: ChatIO,
  statusRegistry: FlowStatusRegistry,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let entry: FlowEntry | null = await queue.waitForEntry(signal);
    if (!entry) break;

    // oauth-start: collapse duplicates for the same provider, use newest
    if (entry.eventType === 'oauth-start') {
      const pid = entry.providerId;
      const dupes = queue.extract(
        (e) => e.eventType === 'oauth-start' && e.providerId === pid,
        'superseded',
      );
      if (dupes.length > 0) {
        const newest = dupes[dupes.length - 1];
        const reason = `superseded by ${newest.flowId}`;
        statusRegistry.emit(entry.flowId, entry.eventType, 'removed', reason);
        for (let i = 0; i < dupes.length - 1; i++) {
          statusRegistry.emit(
            dupes[i].flowId,
            dupes[i].eventType,
            'removed',
            reason,
          );
        }
        entry = newest;
      }
    }

    await processFlow(entry, chatLock, chat, statusRegistry, signal);
  }
}

/**
 * Process a single flow entry. Acquires chatLock, presents event, awaits reply,
 * delivers, releases lock.
 *
 * Exported so Claude's auth runner can process an extracted entry directly
 * without chatLock (post-exit, no contention).
 */
export async function processFlow(
  entry: FlowEntry,
  chatLock: AsyncMutex | null,
  chat: ChatIO,
  statusRegistry: FlowStatusRegistry,
  signal?: AbortSignal,
): Promise<void> {
  if (chatLock) {
    await chatLock.acquire();
  }
  try {
    statusRegistry.emit(
      entry.flowId,
      entry.eventType,
      'active',
      'presenting to user',
    );

    // Notification-only: no reply expected
    if (!entry.replyFn) {
      if (entry.eventType === 'device-code' && entry.eventUrl) {
        // Bare code (copyable), then instruction with URL
        await chat.sendRaw(entry.eventParam);
        await chat.send(
          `${FLOW_PREFIX}Copy the code above and open ${entry.eventUrl} to complete authentication.`,
        );
      } else {
        await chat.send(
          `${FLOW_PREFIX} *${entry.providerId}* Event ${entry.eventType}\n${entry.eventParam}\n${entry.eventUrl}`,
        );
      }
      statusRegistry.emit(
        entry.flowId,
        entry.eventType,
        'completed',
        'notification delivered (no reply expected)',
      );
      logger.info(
        { flowId: entry.flowId },
        'Flow completed (notification-only)',
      );
      return;
    }

    // Interactive: present and collect reply, loop until done
    const parts = [
      `${FLOW_PREFIX}*${entry.providerId}* needs input.`,
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
          entry.flowId,
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
          entry.flowId,
          entry.eventType,
          'failed',
          'user cancelled',
        );
        logger.info({ flowId: entry.flowId }, 'Flow cancelled by user');
        return;
      }

      chat.hideMessage();
      chat.advanceCursor();

      const result = await entry.replyFn(reply.trim());
      done = result.done;

      if (done) {
        statusRegistry.emit(
          entry.flowId,
          entry.eventType,
          'completed',
          result.response ?? 'done',
        );
        await chat.send(
          `${FLOW_PREFIX}*${entry.providerId}* completed.` +
            (result.response ? ` ${result.response}` : ''),
        );
        logger.info({ flowId: entry.flowId }, 'Flow completed successfully');
      } else {
        // Not done — show response and prompt again
        await chat.send(
          `${FLOW_PREFIX}${result.response ?? 'Please try again.'}`,
        );
      }
    }
  } catch (err) {
    statusRegistry.emit(
      entry.flowId,
      entry.eventType,
      'failed',
      `error: ${err instanceof Error ? err.message : String(err)}`,
    );
    logger.error({ flowId: entry.flowId, err }, 'Flow processing error');
  } finally {
    if (chatLock) {
      chatLock.release();
    }
  }
}
