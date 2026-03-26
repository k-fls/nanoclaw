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
 * Processes flows one at a time: acquire lock → present URL → await reply
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
    const entry = await queue.waitForEntry(signal);
    if (!entry) break;

    await processFlow(entry, chatLock, chat, statusRegistry, signal);
  }
}

/**
 * Process a single flow entry. Acquires chatLock, presents URL, awaits reply,
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
    statusRegistry.emit(entry.flowId, entry.providerId, 'active', 'presenting to user');

    await chat.send(
      `${FLOW_PREFIX}*${entry.providerId}* needs authentication.\n` +
      `Please open this URL and complete the flow:\n${entry.url}\n\n` +
      `Reply with the auth code when done, or "cancel" to skip.`,
    );

    // Await user reply — respect AbortSignal for cancellation
    const timeoutMs = 10 * 60 * 1000; // 10 minutes
    const reply = await chat.receive(timeoutMs);

    if (signal?.aborted) {
      statusRegistry.emit(entry.flowId, entry.providerId, 'failed', 'consumer cancelled (container exited)');
      return;
    }

    if (!reply || reply.trim().toLowerCase() === 'cancel') {
      statusRegistry.emit(entry.flowId, entry.providerId, 'failed', 'user cancelled');
      logger.info({ flowId: entry.flowId }, 'Flow cancelled by user');
      return;
    }

    chat.advanceCursor();

    if (!entry.deliveryFn) {
      // Non-localhost redirect — no callback port. The user completed auth
      // in their browser; we collected the reply but can't deliver it.
      statusRegistry.emit(entry.flowId, entry.providerId, 'completed', 'user confirmed (no callback delivery)');
      await chat.send(`${FLOW_PREFIX}Authentication for *${entry.providerId}* noted. The OAuth provider should handle the redirect directly.`);
      logger.info({ flowId: entry.flowId }, 'Flow completed (no deliveryFn, non-localhost redirect)');
    } else {
      // Deliver — deliveryFn must catch dead-target errors internally
      const result = await entry.deliveryFn(reply.trim());

      if (result.ok) {
        statusRegistry.emit(entry.flowId, entry.providerId, 'completed', 'callback delivered successfully');
        await chat.send(`${FLOW_PREFIX}Authentication for *${entry.providerId}* completed.`);
        logger.info({ flowId: entry.flowId }, 'Flow completed successfully');
      } else {
        statusRegistry.emit(
          entry.flowId,
          entry.providerId,
          'failed',
          `delivery failed: ${result.error ?? 'unknown'}`,
        );
        await chat.send(`${FLOW_PREFIX}Authentication for *${entry.providerId}* failed: ${result.error ?? 'delivery error'}`);
        logger.warn({ flowId: entry.flowId, error: result.error }, 'Flow delivery failed');
      }
    }
  } catch (err) {
    statusRegistry.emit(
      entry.flowId,
      entry.providerId,
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
