/**
 * Auth guard — thin integration layer for index.ts.
 * Encapsulates credential checking, stream auth error detection, and reauth triggering.
 */
import type { RegisteredGroup } from '../types.js';
import type { ChatIO, CredentialProvider } from './types.js';
import { isAuthError, extractStreamRequestId } from './providers/claude.js';
import { resolveScope } from './provision.js';
import { runReauth } from './reauth.js';
import { processFlow } from './flow-consumer.js';
import { FlowStatusRegistry } from './flow-status.js';
import type { FlowQueue } from './flow-queue.js';
import type { PendingAuthErrors } from './pending-auth-errors.js';
import { logger } from '../logger.js';

/**
 * Try to refresh the given provider's credentials for this group.
 * Returns true if credentials are now available.
 */
async function tryRefreshProvider(
  group: RegisteredGroup,
  provider: CredentialProvider,
  scope: string,
  force?: boolean,
): Promise<boolean> {
  if (!provider.refresh) return false;

  logger.info({ group: group.name, provider: provider.service, scope, force }, 'Attempting credential refresh');
  try {
    return await provider.refresh(scope, force);
  } catch (err) {
    logger.warn({ group: group.name, provider: provider.service, scope, err }, 'Credential refresh threw');
  }
  return false;
}

const MAX_REASON_LEN = 200;

/** Strip formatting, control chars, and truncate to make agent error text safe for chat display. */
function sanitizeReason(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')            // HTML tags
    .replace(/[*_`~[\]]/g, '')          // markdown formatting
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{S}]/gu, '') // keep only letters, numbers, punctuation, spaces, symbols
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, MAX_REASON_LEN) + (raw.length > MAX_REASON_LEN ? '…' : '');
}

export function createAuthGuard(
  group: RegisteredGroup,
  createChat: () => ChatIO,
  closeStdin: () => void,
  /** The provider whose credentials power the session. */
  provider: CredentialProvider,
  /** Optional pending auth errors tracker for proxy-confirmed detection. */
  pendingErrors?: PendingAuthErrors,
  /** Optional flow queue — if provided, handleAuthError checks for queued Claude OAuth URLs. */
  flowQueue?: FlowQueue,
  /** Status registry for flow events (needed when processing queued entries). */
  statusRegistry?: FlowStatusRegistry,
) {
  let streamedAuthError: string | null = null;

  /**
   * Check if an error string is a confirmed auth error.
   * With pendingErrors: requires both proxy and agent to agree (request_id correlation).
   * Without pendingErrors: falls back to regex-only detection (legacy behavior).
   */
  function isConfirmedAuthError(error: string): boolean {
    if (!isAuthError(error)) return false;

    if (pendingErrors) {
      const requestId = extractStreamRequestId(error);
      if (requestId && pendingErrors.has(requestId)) {
        return true;
      }
      // Proxy didn't record this request_id — could be a false positive.
      // Fall through to legacy detection for backwards compatibility during migration.
      logger.debug(
        { group: group.name, requestId },
        'Auth error detected in stream but not confirmed by proxy, using legacy detection',
      );
    }

    // Legacy: regex match alone is sufficient (no proxy confirmation)
    return true;
  }

  return {
    /** Check credentials before agent run. Returns false if reauth failed. */
    async preCheck(): Promise<boolean> {
      const scope = resolveScope(group);

      // Check if provider can serve usable credentials
      if (Object.keys(provider.provision(scope).env).length > 0) return true;

      // Credentials missing or expired — try refresh
      if (await tryRefreshProvider(group, provider, scope)) return true;

      logger.warn({ group: group.name }, 'No credentials available, starting reauth');
      return runReauth(group.folder, createChat(), 'No credentials configured', provider.displayName);
    },

    /** Call from streaming callback. Detects auth errors and kills container. */
    onStreamResult(result: { status: string; result?: string | null; error?: string }): void {
      if (typeof result.error === 'string' && isConfirmedAuthError(result.error)) {
        streamedAuthError = result.error;
      } else if (typeof result.result === 'string' && isConfirmedAuthError(result.result)) {
        streamedAuthError = result.result;
      }
      if (streamedAuthError) {
        closeStdin();
      }
    },

    /**
     * Handle auth errors after agent run.
     * Returns 'not-auth' if not an auth error, 'reauth-ok' or 'reauth-failed' otherwise.
     */
    async handleAuthError(agentError?: string): Promise<'not-auth' | 'reauth-ok' | 'reauth-failed'> {
      if (agentError && isAuthError(agentError)) {
        streamedAuthError = agentError;
      }
      if (!streamedAuthError) return 'not-auth';

      const reason = streamedAuthError;
      streamedAuthError = null;
      pendingErrors?.clear();

      if (await tryRefreshProvider(group, provider, resolveScope(group), true)) {
        logger.info({ group: group.name }, 'Credential refresh succeeded, skipping reauth');
        return 'reauth-ok';
      }

      // Check if the flow queue has a Claude OAuth URL captured during the agent run.
      // The FIFO consumer was cancelled (step 5-6), but the entry may still be in the queue.
      // Process it directly — no chatLock needed (consumer is dead, agent is dead).
      if (flowQueue) {
        const entry = flowQueue.removeByProvider('claude');
        if (entry) {
          logger.info({ flowId: entry.flowId }, 'Auth error: using queued Claude OAuth URL');
          const chat = createChat();
          const reg = statusRegistry ?? new FlowStatusRegistry();
          await processFlow(entry, null, chat, reg);
          chat.advanceCursor();
          // Check if credentials are now available after the flow
          if (await tryRefreshProvider(group, provider, resolveScope(group), true)) {
            return 'reauth-ok';
          }
          if (Object.keys(provider.provision(resolveScope(group)).env).length > 0) {
            return 'reauth-ok';
          }
          // Flow completed but credentials still not available — fall through to reauth menu
        }
      }

      logger.warn({ group: group.name, reason }, 'Auth error detected, starting reauth');
      const ok = await runReauth(group.folder, createChat(), `Agent failed: ${sanitizeReason(reason)}`, provider.displayName);
      return ok ? 'reauth-ok' : 'reauth-failed';
    },
  };
}
