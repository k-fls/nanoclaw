/**
 * OAuth flow wiring — connects proxy interceptions and browser-open
 * events to the session flow queue.
 *
 * Extracted from index.ts to keep auth plumbing in the auth layer.
 */
import crypto from 'crypto';

import { callbackHandler } from './providers/claude.js';
import {
  setAuthErrorResolver,
  setDeviceCodeNotifyResolver,
  setOAuthInitiationResolver,
} from './universal-oauth-handler.js';
import { setBrowserOpenCallback } from './browser-open-handler.js';
import type { CredentialProxy } from '../credential-proxy.js';
import type { ContainerSessionContext } from './session-context.js';
import { logger } from '../logger.js';

/**
 * Parse an OAuth authorization URL, build a FlowEntry, push to the
 * session's flow queue. Returns the flowId.
 */
function pushOAuthFlow(
  ctx: ContainerSessionContext,
  url: string,
  containerIP: string,
  providerId: string,
  reason: string,
): string {
  let callbackPort: number | null = null;
  let callbackPath = '/callback';
  let isLocalhost = false;

  // flowId format: providerId:callbackPort:stateHash
  let flowId: string;
  try {
    const parsed = new URL(url);
    const redirectUri = parsed.searchParams.get('redirect_uri');
    if (redirectUri) {
      const redirectUrl = new URL(redirectUri);
      const host = redirectUrl.hostname;
      isLocalhost =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        host === '::1';
      if (isLocalhost) {
        callbackPort = parseInt(redirectUrl.port, 10) || null;
        callbackPath = redirectUrl.pathname || '/callback';
      }
    }
    const state = parsed.searchParams.get('state') || url;
    const stateHash = crypto
      .createHash('sha256')
      .update(state)
      .digest('base64url')
      .slice(0, 8);
    flowId = `${providerId}:${callbackPort || 0}:${stateHash}`;
  } catch (err) {
    logger.warn(
      { err, providerId, url },
      'Failed to parse OAuth URL for flowId',
    );
    flowId = `${providerId}:0:${Date.now()}`;
  }

  // Build replyFn only for localhost callbacks — non-localhost redirects
  // are handled by the OAuth provider directly (browser redirect).
  // Reuses callbackHandler for URL parsing and validation.
  let handler: ReturnType<typeof callbackHandler> | null = null;
  if (isLocalhost && callbackPort && containerIP) {
    const host = containerIP.includes(':') ? `[${containerIP}]` : containerIP;
    handler = callbackHandler(url, host, callbackPort, callbackPath);
  }

  ctx.flowQueue.push(
    {
      flowId,
      eventType: 'oauth-start',
      providerId,
      eventParam: handler?.instructions ?? '',
      eventUrl: url,
      replyFn: handler?.deliver.bind(handler) ?? null,
    },
    reason,
  );
  return flowId;
}

/**
 * Wire all auth callbacks that bridge the proxy to the session flow queues.
 * Called once at startup from index.ts.
 */
export function wireAuthCallbacks(proxy: CredentialProxy): void {
  // Bearer-swap handler looks up session context by scope for auth errors
  setAuthErrorResolver((scope) => {
    const ctx = proxy.getSessionContext(scope);
    return ctx?.onAuthError ?? null;
  });

  // Authorize-stub handler pushes OAuth URLs to session's flow queue
  setOAuthInitiationResolver((eventScope) => {
    const ctx = proxy.getSessionContext(eventScope);
    if (!ctx) return null;
    return (authUrl: string, providerId: string, containerIP: string) => {
      pushOAuthFlow(
        ctx,
        authUrl,
        containerIP,
        providerId,
        'proxy intercepted authorization endpoint',
      );
    };
  });

  // Device-code handler pushes user_code + verification_uri
  setDeviceCodeNotifyResolver((eventScope) => {
    const ctx = proxy.getSessionContext(eventScope);
    if (!ctx) return null;
    return (providerId, userCode, verificationUri) => {
      ctx.flowQueue.push(
        {
          flowId: `${providerId}:device:${Date.now()}`,
          eventType: 'device-code',
          providerId,
          eventParam: userCode,
          eventUrl: verificationUri,
          replyFn: null,
        },
        'device code flow initiated',
      );
    };
  });

  // xdg-open shim pushes OAuth URLs to session's flow queue
  setBrowserOpenCallback(
    ({ url, scope: eventScope, containerIP, providerId }) => {
      const ctx = proxy.getSessionContext(eventScope);
      if (!ctx) {
        logger.warn(
          { scope: eventScope },
          'browser-open: no session context for scope',
        );
        return null;
      }
      return pushOAuthFlow(
        ctx,
        url,
        containerIP,
        providerId,
        'xdg-open shim detected OAuth URL',
      );
    },
  );
}
