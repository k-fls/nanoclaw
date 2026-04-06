/**
 * Interaction module — shared infrastructure for user-facing interactions.
 *
 * Provides a queue-based event system where components push events
 * (auth, SSH, web-form, etc.) and a single consumer dispatches them
 * to registered per-event-type handlers.
 */

export { AsyncMutex } from './async-mutex.js';
export { createChatIO, type ChatIODeps } from './chat-io.js';
export {
  consumeInteractions,
  createHandlerContext,
  defaultHandler,
  InteractionAbortedError,
  registerInteractionHandler,
  type HandlerContext,
  type InteractionHandler,
} from './consumer.js';
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
export {
  getInteractionSession,
  startInteractionSession,
  type InteractionSession,
} from './session.js';
