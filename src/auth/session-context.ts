/**
 * Container session context.
 *
 * Per-handleMessages object holding all per-scope state for one agent invocation.
 * Lives as a local variable in handleMessages — outlives the container
 * (reauth runs after container death, before handleMessages returns).
 *
 * The proxy's containerIpToScope mapping is a separate concern with a separate
 * lifetime. The auth error callback bridges them: bearer-swap resolves scope
 * from container IP, then looks up this context's callback.
 */
import { FlowQueue } from './flow-queue.js';
import { FlowStatusRegistry } from './flow-status.js';
import { PendingAuthErrors } from './pending-auth-errors.js';

// ── Types ───────────────────────────────────────────────────────────

/**
 * Callback invoked by the bearer-swap handler when a 401/403 occurs
 * and refresh fails. Receives the buffered upstream response body
 * so the callback can extract provider-specific data (e.g. request_id).
 */
export type AuthErrorCallback = (
  responseBody: string,
  statusCode: number,
) => void;

// ── ContainerSessionContext ─────────────────────────────────────────

export interface ContainerSessionContext {
  /** The group's credential scope. */
  scope: string;

  /** Pending auth errors tracker — wires proxy to auth guard. */
  pendingErrors: PendingAuthErrors;

  /** Flow queue for this session. */
  flowQueue: FlowQueue;

  /** Status registry for SSE endpoints. */
  statusRegistry: FlowStatusRegistry;

  /**
   * Auth error callback — called by bearer-swap handler on 401/403
   * when refresh fails. Extracts request_id and records in pendingErrors.
   */
  onAuthError: AuthErrorCallback;
}

/**
 * Create a session context for one agent invocation.
 *
 * @param scope The group's credential scope
 * @param extractRequestId Provider-specific function to extract request ID from upstream error body.
 *                          Returns null if the body doesn't contain a recognizable ID.
 */
export function createSessionContext(
  scope: string,
  extractRequestId: (responseBody: string) => string | null,
): ContainerSessionContext {
  const pendingErrors = new PendingAuthErrors();
  const flowQueue = new FlowQueue();
  const statusRegistry = new FlowStatusRegistry();

  // Wire queue mutations to status registry
  flowQueue.onMutation((flowId, eventType, event, reason) => {
    statusRegistry.emit(flowId, eventType, event, reason);
  });

  const onAuthError: AuthErrorCallback = (responseBody, statusCode) => {
    const requestId = extractRequestId(responseBody);
    if (requestId) {
      pendingErrors.record(requestId);
    }
  };

  return {
    scope,
    pendingErrors,
    flowQueue,
    statusRegistry,
    onAuthError,
  };
}
