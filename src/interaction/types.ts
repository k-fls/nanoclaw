/**
 * Shared types for the interaction module.
 *
 * ChatIO is the core interface — any component that needs to talk to
 * a user implements or receives a ChatIO. InteractionEntry and friends
 * define the queue-based event pattern used by interactions.
 */

// ── ChatIO ─────────────────────────────────────────────────────────

/**
 * ChatIO uses normal message routing — no special interception.
 * send() goes through the router (same path as container agent responses).
 * receive() polls main group messages, waiting for a user reply.
 */
export interface ChatIO {
  send(text: string): Promise<void>;
  /** Send without any prefix decoration (e.g. for PGP keys that must be copy-pasteable). */
  sendRaw(text: string): Promise<void>;
  /** Polls main group messages. Returns null on timeout. */
  receive(timeoutMs?: number): Promise<string | null>;
  /** Mark the last received message as hidden so the agent never sees it. */
  hideMessage(): void;
  /** Advance the message cursor past all current messages so the agent won't re-see them. */
  advanceCursor(): void;
}

// ── Interaction prefix ─────────────────────────────────────────────

let _interactionPrefix = '';

/** Set the global interaction prefix shown to the user on all interaction messages. */
export function setInteractionPrefix(prefix: string): void {
  _interactionPrefix = prefix;
}

/** Get the current global interaction prefix. */
export function getInteractionPrefix(): string {
  return _interactionPrefix;
}
