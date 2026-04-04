/**
 * Interaction module — shared infrastructure for user-facing interactions.
 *
 * Provides a queue-based event system where components push events
 * (auth, SSH, web-form, etc.) and a single consumer presents them
 * to the user and collects replies.
 */

export { AsyncMutex } from './async-mutex.js';
export { createChatIO, type ChatIODeps } from './chat-io.js';
export { consumeInteractions, processInteraction } from './consumer.js';
export {
  InteractionQueue,
  type DeliveryResult,
  type InteractionEntry,
  type InteractionEventKind,
  type QueueMutationCallback,
  type ReplyFn,
} from './queue.js';
export {
  InteractionStatusRegistry,
  type InteractionEvent,
  type InteractionState,
} from './status.js';
export {
  type ChatIO,
  setInteractionPrefix,
  getInteractionPrefix,
} from './types.js';
