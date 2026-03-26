/**
 * OAuth flow queue — single source of truth for pending OAuth flows.
 *
 * Ordered, async-safe queue with provider dedup, blocking pop, and
 * out-of-order extraction by providerId.
 */
import { logger } from '../logger.js';

// ── Types ───────────────────────────────────────────────────────────

/** Result of a delivery attempt. */
export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

/**
 * Delivers a user-provided auth code/reply to the waiting consumer
 * (callback port or stdin pipe inside the container).
 *
 * Must catch dead-target errors (ECONNREFUSED, broken pipe) and return
 * `{ ok: false, error: '...' }` rather than throwing.
 */
export type DeliveryFn = (reply: string) => Promise<DeliveryResult>;

/** A pending OAuth flow in the queue. */
export interface FlowEntry {
  flowId: string;
  providerId: string;
  url: string;
  /**
   * Delivers the user's reply to the waiting consumer.
   * Null when the redirect_uri is non-localhost — no callback port to hit.
   * The consumer still presents the URL and collects the reply, but cannot
   * deliver it programmatically.
   */
  deliveryFn: DeliveryFn | null;
}

/** Callback for queue mutations — wired to the status registry. */
export type QueueMutationCallback = (
  flowId: string,
  providerId: string,
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
   * Push a flow entry. If the same providerId already has a pending entry,
   * it is removed first and the new entry is appended at the end.
   * @param reason Textual explanation for the mutation — forwarded to status registry.
   */
  push(entry: FlowEntry, reason: string): void {
    // Dedup by provider
    const idx = this.entries.findIndex((e) => e.providerId === entry.providerId);
    if (idx !== -1) {
      const old = this.entries.splice(idx, 1)[0];
      logger.info(
        { flowId: old.flowId, providerId: old.providerId },
        'Flow queue: removed superseded entry',
      );
      this._onMutation?.(old.flowId, old.providerId, 'removed', `superseded: ${reason}`);
    }

    this.entries.push(entry);
    logger.info(
      { flowId: entry.flowId, providerId: entry.providerId },
      'Flow queue: entry added',
    );
    this._onMutation?.(entry.flowId, entry.providerId, 'queued', reason);

    // Wake consumer if blocked
    this._notify?.();
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

  /** Check if a provider has a pending entry without removing it. */
  hasProvider(providerId: string): boolean {
    return this.entries.some((e) => e.providerId === providerId);
  }
}
