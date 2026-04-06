/**
 * Auth guard — single auth facade for handleMessages.
 *
 * Owns session lifecycle (context, flow consumer, proxy registration)
 * and credential checking / reauth triggering. index.ts just calls
 * withAuthGuard() which encapsulates the full lifecycle.
 */
import type { RegisteredGroup, Channel } from '../types.js';
import type { ChatIO, CredentialProvider } from './types.js';
import type { CredentialProxy } from './credential-proxy.js';
import { getProxy } from './credential-proxy.js';
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
import {
  createChatIO,
  type ChatIODeps,
  type InteractionSession,
} from '../interaction/index.js';
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
   * Start auth session: register session context with proxy,
   * check credentials. Returns false if reauth failed.
   */
  start(): Promise<boolean>;

  /** Call from streaming callback. Detects auth errors and kills container. */
  onStreamResult(result: {
    status: string;
    result?: string | null;
    error?: string;
  }): void;

  /**
   * Finish auth session: handle auth errors, clean up.
   * Returns 'not-auth' | 'reauth-ok' | 'reauth-failed'.
   */
  finish(
    agentError?: string,
  ): Promise<'not-auth' | 'reauth-ok' | 'reauth-failed'>;

  /** Set the container name once known (after spawn). */
  setContainerName(name: string): void;
}

export function createAuthGuard(
  group: RegisteredGroup,
  proxy: CredentialProxy,
  createChat: () => ChatIO,
  stopContainer: () => void,
  session: InteractionSession,
  /** Override provider for testing. Defaults to claudeProvider. */
  provider: CredentialProvider = claudeProvider,
): AuthGuard {
  const scope = scopeOf(group);
  const sessionCtx = createSessionContext(
    scope,
    extractUpstreamRequestId,
    session.queue,
    session.statusRegistry,
  );

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
    setContainerName(name: string): void {
      sessionCtx.containerName = name;
    },

    async start(): Promise<boolean> {
      proxy.registerSessionContext(scope, sessionCtx);

      // Check credentials
      const engine = getTokenEngine();
      if (engine.hasAnyCredential(scope, provider.id)) return true;

      logger.warn(
        { group: group.name },
        'No credentials available, starting reauth',
      );
      return runReauth(
        scope,
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
        stopContainer();
      }
    },

    async finish(agentError?: string) {
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
          scope,
          createChat(),
          `Agent failed: ${sanitizeReason(reason)}`,
          provider.displayName,
          engine,
        );
        authResult = ok ? 'reauth-ok' : 'reauth-failed';
      }

      // Cleanup session (statusRegistry lifecycle owned by interaction session)
      proxy.deregisterSessionContext(scope);

      return authResult;
    },
  };
}

// ── withAuthGuard ──────────────────────────────────────────────────
// Higher-order wrapper that encapsulates the full auth guard lifecycle
// so index.ts only needs a single call site.

/** Outcome of a guarded agent run. */
export type GuardedResult =
  | { outcome: 'no-credentials' }
  | { outcome: 'reauth-ok' }
  | { outcome: 'reauth-failed' }
  | {
      outcome: 'done';
      agentStatus: 'success' | 'error';
      error?: string;
      fatal?: boolean;
    };

export interface WithAuthGuardDeps {
  group: RegisteredGroup;
  chatIODeps: ChatIODeps;
  stopContainer: () => void;
  session: InteractionSession;
  /**
   * The actual agent run. Receives the guard so streaming callbacks can
   * call guard.onStreamResult().
   */
  runAgent: (guard: AuthGuard) => Promise<{
    status: 'success' | 'error';
    error?: string;
    fatal?: boolean;
  }>;
}

/**
 * Run an agent invocation wrapped in the full auth guard lifecycle.
 *
 * 1. Creates guard, checks credentials (triggers reauth if missing)
 * 2. Calls runAgent callback — caller wires streaming output
 * 3. Finishes guard — handles auth errors, reauth, cleanup
 */
export async function withAuthGuard(
  deps: WithAuthGuardDeps,
): Promise<GuardedResult> {
  const { group, chatIODeps, stopContainer, session, runAgent } = deps;

  const guard = createAuthGuard(
    group,
    getProxy(),
    () => createChatIO(chatIODeps),
    stopContainer,
    session,
  );

  const credentialsOk = await guard.start();
  if (!credentialsOk) {
    return { outcome: 'no-credentials' };
  }

  const agentResult = await runAgent(guard);

  const authResult = await guard.finish(
    agentResult.status === 'error' ? agentResult.error : undefined,
  );

  if (authResult === 'reauth-failed') return { outcome: 'reauth-failed' };
  if (authResult === 'reauth-ok') return { outcome: 'reauth-ok' };

  return {
    outcome: 'done',
    agentStatus: agentResult.status,
    error: agentResult.error,
    fatal: agentResult.fatal,
  };
}
