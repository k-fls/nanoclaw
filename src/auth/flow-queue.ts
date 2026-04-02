/**
 * Event flow queue — single source of truth for pending user-facing events.
 *
 * Ordered, async-safe queue with blocking pop and FIFO consumption.
 * Generic enough for any event that needs to notify the user and
 * optionally collect a reply.
 *
 * The queue itself does NOT dedup — callers decide whether to supersede
 * an existing entry via find() + remove() before pushing.
 */
import { logger } from '../logger.js';

// ── Types ───────────────────────────────────────────────────────────

/** Result of delivering a user reply back to the event source. */
export interface DeliveryResult {
  /** True when the interaction is complete. False means the user should reply again. */
  done: boolean;
  /** Optional message to show the user (status, follow-up prompt, error detail). */
  response?: string;
}

/**
 * Delivers a user-provided reply back to the event source
 * (e.g. OAuth callback port, stdin pipe inside the container).
 *
 * Must catch dead-target errors (ECONNREFUSED, broken pipe) and return
 * `{ done: true, response: '...' }` rather than throwing.
 */
export type ReplyFn = (reply: string) => Promise<DeliveryResult>;

/** @deprecated Use ReplyFn — kept for migration convenience. */
export type DeliveryFn = ReplyFn;

/**
 * Event category — controls consumer behavior and message formatting.
 * Add new values here as new event kinds are introduced.
 */
export type FlowEventKind =
  | 'oauth-start'
  | 'oauth-refresh'
  | 'device-code'
  | 'notification';

/** A pending event in the queue. */
export interface FlowEntry {
  flowId: string;
  eventType: FlowEventKind;
  /** Display label for the user (e.g. provider name, service). */
  providerId: string;
  /** Event payload shown to the user (code, message text, etc.). */
  eventParam: string;
  /** URL associated with the event (authorization URL, verification URI, etc.). */
  eventUrl?: string;
  /**
   * Delivers the user's reply back to the event source.
   * When present, the consumer collects user input and calls this
   * repeatedly until `done: true` or the user cancels.
   * When null, the event is notification-only (no reply expected).
   */
  replyFn: ReplyFn | null;
}

/** Callback for queue mutations — wired to the status registry. */
export type QueueMutationCallback = (
  flowId: string,
  eventType: FlowEventKind,
  event: 'queued' | 'removed',
  reason: string,
) => void;

// ── FlowQueue ───────────────────────────────────────────────────────

export class FlowQueue {
  private entries: FlowEntry[] = [];
  private _notify: (() => void) | null = null;
  private _onMutation: QueueMutationCallback | null = null;

  /** Set a callback for queue mutations (add/remove). */
  onMutation(cb: QueueMutationCallback): void {
    this._onMutation = cb;
  }

  /** Number of pending entries. */
  get length(): number {
    return this.entries.length;
  }

  /**
   * Append an entry to the queue. No dedup — callers should use
   * find() + remove() beforehand if they want to supersede.
   */
  push(entry: FlowEntry, reason: string): void {
    this.entries.push(entry);
    logger.info(
      {
        flowId: entry.flowId,
        eventType: entry.eventType,
        providerId: entry.providerId,
      },
      'Flow queue: entry added',
    );
    this._onMutation?.(entry.flowId, entry.eventType, 'queued', reason);

    // Wake consumer if blocked
    this._notify?.();
  }

  /**
   * Extract all entries matching a predicate. Removes them from the queue
   * and returns them. Fires the mutation callback for each removal.
   */
  extract(predicate: (e: FlowEntry) => boolean, reason: string): FlowEntry[] {
    const extracted: FlowEntry[] = [];
    this.entries = this.entries.filter((e) => {
      if (predicate(e)) {
        extracted.push(e);
        return false;
      }
      return true;
    });
    for (const e of extracted) {
      logger.info(
        { flowId: e.flowId, eventType: e.eventType },
        'Flow queue: entry extracted',
      );
      this._onMutation?.(e.flowId, e.eventType, 'removed', reason);
    }
    return extracted;
  }

  /**
   * Blocking pop from front. Blocks when empty, wakes on push or abort.
   * Returns null if the signal is aborted.
   */
  async waitForEntry(signal: AbortSignal): Promise<FlowEntry | null> {
    while (this.entries.length === 0) {
      if (signal.aborted) return null;
      await new Promise<void>((resolve) => {
        this._notify = resolve;
        const onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
      });
      this._notify = null;
    }
    if (signal.aborted) return null;
    return this.entries.shift()!;
  }

  /** Check if any pending entry matches a predicate. */
  has(predicate: (e: FlowEntry) => boolean): boolean {
    return this.entries.some(predicate);
  }
}
