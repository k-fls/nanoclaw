/**
 * Auth guard — single auth facade for handleMessages.
 *
 * Owns session lifecycle (context, flow consumer, proxy registration)
 * and credential checking / reauth triggering. index.ts just calls
 * start(), onStreamResult(), finish().
 */
import type { RegisteredGroup } from '../types.js';
import type { ChatIO, CredentialProvider } from './types.js';
import type { CredentialProxy } from '../credential-proxy.js';
import {
  isAuthError,
  extractStreamRequestId,
  extractUpstreamRequestId,
  claudeProvider,
} from './providers/claude.js';
import { runReauth } from './reauth.js';
import { getTokenEngine } from './registry.js';
import { scopeOf } from '../types.js';
import { createSessionContext } from './session-context.js';
import { consumeFlows } from './flow-consumer.js';
import { AsyncMutex } from './async-mutex.js';
import { logger } from '../logger.js';

const MAX_REASON_LEN = 200;

/** Strip formatting, control chars, and truncate to make agent error text safe for chat display. */
function sanitizeReason(raw: string): string {
  return (
    raw
      .replace(/<[^>]*>/g, '') // HTML tags
      .replace(/[*_`~[\]]/g, '') // markdown formatting
      .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{S}]/gu, '') // keep only letters, numbers, punctuation, spaces, symbols
      .replace(/\s+/g, ' ') // collapse whitespace
      .trim()
      .slice(0, MAX_REASON_LEN) + (raw.length > MAX_REASON_LEN ? '…' : '')
  );
}

export interface AuthGuard {
  /**
   * Start auth session: register session context with proxy, start flow
   * consumer, check credentials. Returns false if reauth failed.
   */
  start(): Promise<boolean>;

  /** Call from streaming callback. Detects auth errors and kills container. */
  onStreamResult(result: {
    status: string;
    result?: string | null;
    error?: string;
  }): void;

  /**
   * Finish auth session: stop flow consumer, handle auth errors, clean up.
   * Returns 'not-auth' | 'reauth-ok' | 'reauth-failed'.
   */
  finish(
    agentError?: string,
  ): Promise<'not-auth' | 'reauth-ok' | 'reauth-failed'>;

  /**
   * Chat lock shared between the flow consumer and the output sender.
   * Acquire before sending messages to prevent interleaving.
   */
  readonly chatLock: AsyncMutex;
}

export function createAuthGuard(
  group: RegisteredGroup,
  proxy: CredentialProxy,
  createChat: () => ChatIO,
  closeStdin: () => void,
  /** Override provider for testing. Defaults to claudeProvider. */
  provider: CredentialProvider = claudeProvider,
): AuthGuard {
  const scope = scopeOf(group);
  const sessionCtx = createSessionContext(scope, extractUpstreamRequestId);
  const chatLock = new AsyncMutex();
  const flowAbort = new AbortController();

  let consumerPromise: Promise<void> | null = null;
  let streamedAuthError: string | null = null;

  function isConfirmedAuthError(error: string): boolean {
    if (!isAuthError(error)) return false;

    const requestId = extractStreamRequestId(error);
    if (requestId && sessionCtx.pendingErrors.has(requestId)) {
      return true;
    }
    logger.debug(
      { group: group.name, requestId },
      'Auth error in stream not confirmed by proxy — ignoring',
    );
    return false;
  }

  return {
    chatLock,

    async start(): Promise<boolean> {
      proxy.registerSessionContext(scope, sessionCtx);

      consumerPromise = consumeFlows(
        sessionCtx.flowQueue,
        chatLock,
        createChat(),
        sessionCtx.statusRegistry,
        flowAbort.signal,
      );

      // Check credentials
      const engine = getTokenEngine();
      if (engine.hasAnyCredential(scope, provider.id)) return true;

      logger.warn(
        { group: group.name },
        'No credentials available, starting reauth',
      );
      return runReauth(
        group.folder,
        createChat(),
        'No credentials configured',
        provider.displayName,
        engine,
      );
    },

    onStreamResult(result): void {
      if (
        typeof result.error === 'string' &&
        isConfirmedAuthError(result.error)
      ) {
        streamedAuthError = result.error;
      } else if (
        typeof result.result === 'string' &&
        isConfirmedAuthError(result.result)
      ) {
        streamedAuthError = result.result;
      }
      if (streamedAuthError) {
        closeStdin();
      }
    },

    async finish(agentError?: string) {
      // Stop flow consumer
      flowAbort.abort();
      if (consumerPromise) await consumerPromise;

      if (agentError && isAuthError(agentError)) {
        streamedAuthError = agentError;
      }

      let authResult: 'not-auth' | 'reauth-ok' | 'reauth-failed' = 'not-auth';

      if (streamedAuthError) {
        const reason = streamedAuthError;
        streamedAuthError = null;
        sessionCtx.pendingErrors.clear();

        const engine = getTokenEngine();
        logger.warn(
          { group: group.name, reason },
          'Auth error detected, starting reauth',
        );
        const ok = await runReauth(
          group.folder,
          createChat(),
          `Agent failed: ${sanitizeReason(reason)}`,
          provider.displayName,
          engine,
        );
        authResult = ok ? 'reauth-ok' : 'reauth-failed';
      }

      // Cleanup session
      proxy.deregisterSessionContext(scope);
      sessionCtx.statusRegistry.destroy();

      return authResult;
    },
  };
}
