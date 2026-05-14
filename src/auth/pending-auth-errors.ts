/**
 * Per-session pending auth error tracker.
 *
 * Thin wrapper around a Set of request IDs. The proxy records request IDs
 * from upstream 401/403 responses; the auth guard confirms them when the
 * agent surfaces the error in streaming output. Both sides must agree —
 * no false positives.
 *
 * Lifecycle is container-bounded: created when the agent container starts,
 * goes out of scope when handleMessages returns. No TTL, no cleanup logic.
 */

export class PendingAuthErrors {
  private ids = new Set<string>();

  /** Record a request ID from a proxy-detected auth error. */
  record(requestId: string): void {
    this.ids.add(requestId);
  }

  /** Check if a request ID was recorded by the proxy. */
  has(requestId: string): boolean {
    return this.ids.has(requestId);
  }

  /** Clear all recorded errors (after reauth is triggered). */
  clear(): void {
    this.ids.clear();
  }

  /** Number of pending errors. */
  get size(): number {
    return this.ids.size;
  }
}
