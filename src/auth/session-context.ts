/**
 * Container session context.
 *
 * Per-handleMessages object holding all per-scope state for one agent invocation.
 * Lives as a local variable in handleMessages — outlives the container
 * (reauth runs after container death, before handleMessages returns).
 *
 * The interaction queue and status registry are owned by the interaction
 * session — the context holds references so auth code and the credential
 * proxy can push entries and serve SSE endpoints.
 *
 * The proxy's containerIpToScope mapping is a separate concern with a separate
 * lifetime. The auth error callback bridges them: bearer-swap resolves scope
 * from container IP, then looks up this context's callback.
 */
import type { InteractionQueue } from '../interaction/index.js';
import type { InteractionStatusRegistry } from '../interaction/index.js';
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

  /** Container name for docker exec (set after spawn). */
  containerName: string;

  /** Pending auth errors tracker — wires proxy to auth guard. */
  pendingErrors: PendingAuthErrors;

  /** Interaction queue — owned by the interaction session. */
  interactionQueue: InteractionQueue;

  /** Status registry — owned by the interaction session; used by proxy for SSE. */
  statusRegistry: InteractionStatusRegistry;

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
 * @param interactionQueue Queue from the interaction session.
 * @param statusRegistry Status registry from the interaction session.
 */
export function createSessionContext(
  scope: string,
  extractRequestId: (responseBody: string) => string | null,
  interactionQueue: InteractionQueue,
  statusRegistry: InteractionStatusRegistry,
): ContainerSessionContext {
  const pendingErrors = new PendingAuthErrors();

  const onAuthError: AuthErrorCallback = (responseBody, _statusCode) => {
    const requestId = extractRequestId(responseBody);
    if (requestId) {
      pendingErrors.record(requestId);
    }
  };

  return {
    scope,
    containerName: '',
    pendingErrors,
    interactionQueue,
    statusRegistry,
    onAuthError,
  };
}
