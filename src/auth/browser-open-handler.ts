/**
 * Browser-open proxy endpoint handler.
 *
 * Containers call POST /auth/browser-open when xdg-open is invoked.
 * The handler matches the URL against known authorization_endpoint patterns
 * (from discovery files) and decides whether to relay the OAuth URL to the
 * user via the messaging channel or pass it through silently.
 *
 * Responses:
 *   Known OAuth URL → { exit_code: 0 } + relay to user via callback
 *   Unknown URL     → {} (pass-through, no exit_code — shim defaults to 0)
 *   Bad request     → { error: "...", exit_code: 1 }
 */
import type { IncomingMessage, ServerResponse } from 'http';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserOpenEvent {
  url: string;
  scope: import('./oauth-types.js').GroupScope;
  /** The container's bridge IP — needed to reach callback ports inside the container. */
  containerIP: string;
  /** The matched provider ID (from discovery files or built-in registration). */
  providerId: string;
}

/**
 * Callback invoked when a known OAuth URL is detected.
 * Returns the flowId (for inclusion in the HTTP response to the shim),
 * or null if the event could not be processed.
 */
export type BrowserOpenCallback = (event: BrowserOpenEvent) => string | null;

// ---------------------------------------------------------------------------
// Authorization endpoint registry
// ---------------------------------------------------------------------------

interface AuthorizationPatternEntry {
  pattern: RegExp;
  providerId: string;
}

/** Compiled patterns from discovery files' authorization_endpoint fields. */
const authorizationPatterns: AuthorizationPatternEntry[] = [];

/** Register an authorization_endpoint URL pattern with its provider ID. */
export function registerAuthorizationPattern(pattern: RegExp, providerId: string): void {
  authorizationPatterns.push({ pattern, providerId });
}

/**
 * Register authorization patterns from a discovery endpoint URL.
 * Extracts the host and builds a regex that matches URLs starting with that host.
 */
export function registerAuthorizationEndpoint(url: string, providerId: string): void {
  try {
    const parsed = new URL(url);
    const escaped = parsed.hostname.replace(/\./g, '\\.');
    const pathEscaped = parsed.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    authorizationPatterns.push({
      pattern: new RegExp(`^https?://${escaped}${pathEscaped}`),
      providerId,
    });
  } catch {
    // Skip invalid URLs
  }
}

/** Match a URL against known authorization endpoints. Returns providerId or null. */
function matchAuthorizationUrl(url: string): string | null {
  const entry = authorizationPatterns.find((e) => e.pattern.test(url));
  return entry?.providerId ?? null;
}

// ---------------------------------------------------------------------------
// Callback registry
// ---------------------------------------------------------------------------

let _onBrowserOpen: BrowserOpenCallback | null = null;

/** Set the callback for browser-open events. Called once at startup. */
export function setBrowserOpenCallback(cb: BrowserOpenCallback): void {
  _onBrowserOpen = cb;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Handle POST /auth/browser-open requests from containers.
 *
 * Request body: { "url": "https://..." }
 */
export async function handleBrowserOpen(
  req: IncomingMessage,
  res: ServerResponse,
  scope: import('./oauth-types.js').GroupScope,
  containerIP?: string,
): Promise<void> {
  // Buffer request body
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', resolve);
  });

  let url: string;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    url = body.url;
    if (!url || typeof url !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing url', exit_code: 1 }));
      return;
    }
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON', exit_code: 1 }));
    return;
  }

  const providerId = matchAuthorizationUrl(url);
  if (!providerId) {
    // Pass through — shim defaults to exit 0, tool thinks browser opened
    logger.debug({ url, scope }, 'browser-open: unknown URL, pass-through');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
    return;
  }

  logger.info({ url, scope, providerId }, 'browser-open: known OAuth URL, relaying');

  let flowId: string | null = null;
  if (_onBrowserOpen) {
    try {
      flowId = _onBrowserOpen({ url, scope, containerIP: containerIP || '', providerId });
    } catch (err) {
      logger.error({ err, scope }, 'browser-open: callback error');
    }
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ exit_code: 0, ...(flowId && { flowId }) }));
}
