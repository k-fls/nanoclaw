/**
 * Auth guard — thin integration layer for index.ts.
 * Encapsulates credential checking, stream auth error detection, and reauth triggering.
 */
import type { RegisteredGroup } from '../types.js';
import type { ChatIO, CredentialProvider } from './types.js';
import { isAuthError, extractStreamRequestId } from './providers/claude.js';
import { resolveScope } from './provision.js';
import { runReauth } from './reauth.js';
import type { PendingAuthErrors } from './pending-auth-errors.js';
import { logger } from '../logger.js';

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
      // Proxy-confirmed mode: both proxy and agent must agree via request_id.
      const requestId = extractStreamRequestId(error);
      if (requestId && pendingErrors.has(requestId)) {
        return true;
      }
      logger.debug(
        { group: group.name, requestId },
        'Auth error in stream not confirmed by proxy — ignoring (not a confirmed auth error)',
      );
      return false;
    }

    // No pendingErrors tracker — regex match alone (legacy, no proxy integration)
    return true;
  }

  return {
    /** Check credentials before agent run. Returns false if reauth failed. */
    async preCheck(): Promise<boolean> {
      const scope = resolveScope(group);

      // Check if provider has stored credentials
      if (provider.hasValidCredentials(scope)) return true;

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

      logger.warn({ group: group.name, reason }, 'Auth error detected, starting reauth');
      const ok = await runReauth(group.folder, createChat(), `Agent failed: ${sanitizeReason(reason)}`, provider.displayName);
      return ok ? 'reauth-ok' : 'reauth-failed';
    },
  };
}
