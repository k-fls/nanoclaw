/**
 * Interaction session — lifecycle wrapper for per-group interaction
 * infrastructure.
 *
 * Encapsulates queue + status registry + consumer loop so index.ts
 * only needs start/stop and access to the chatLock.
 */
import { AsyncMutex } from './async-mutex.js';
import { createChatIO, type ChatIODeps } from './chat-io.js';
import { consumeInteractions, createHandlerContext } from './consumer.js';
import { InteractionQueue } from './queue.js';
import { InteractionStatusRegistry } from './status.js';

export interface InteractionSession {
  /** Acquire before sending messages to prevent interleaving with the consumer. */
  chatLock: AsyncMutex;
  /** Push entries here to trigger user-facing interactions. */
  queue: InteractionQueue;
  /** Stop the consumer loop and clean up. */
  stop(): Promise<void>;
}

/** Active sessions keyed by chatJid. */
const active = new Map<string, InteractionSession>();

/** Get the active interaction session for a group (if any). */
export function getInteractionSession(
  chatJid: string,
): InteractionSession | undefined {
  return active.get(chatJid);
}

/**
 * Start an interaction session: creates the queue, status registry,
 * and consumer loop. Registers in the active map.
 */
export function startInteractionSession(
  chatJid: string,
  deps: ChatIODeps,
): InteractionSession {
  const chatLock = new AsyncMutex();
  const queue = new InteractionQueue();
  const statusRegistry = new InteractionStatusRegistry();
  const abort = new AbortController();

  queue.onMutation((id, type, event, reason) => {
    statusRegistry.emit(id, type, event, reason);
  });

  const { ctx, revoke } = createHandlerContext(
    createChatIO(deps),
    queue,
    statusRegistry,
  );

  const consumer = consumeInteractions(queue, chatLock, ctx, abort.signal);

  const session: InteractionSession = {
    chatLock,
    queue,
    async stop() {
      revoke();
      abort.abort();
      await consumer;
      active.delete(chatJid);
      statusRegistry.destroy();
    },
  };

  active.set(chatJid, session);
  return session;
}
