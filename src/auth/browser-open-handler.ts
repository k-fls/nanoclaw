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
  scope: string;
}

/**
 * Callback invoked when a known OAuth URL is detected.
 * The host wires this to relay the URL through the messaging channel
 * and store the callback port for code delivery.
 */
export type BrowserOpenCallback = (event: BrowserOpenEvent) => void;

// ---------------------------------------------------------------------------
// Authorization endpoint registry
// ---------------------------------------------------------------------------

/** Compiled patterns from discovery files' authorization_endpoint fields. */
const authorizationPatterns: RegExp[] = [];

/** Register an authorization_endpoint URL pattern for matching. */
export function registerAuthorizationPattern(pattern: RegExp): void {
  authorizationPatterns.push(pattern);
}

/**
 * Register authorization patterns from a discovery endpoint URL.
 * Extracts the host and builds a regex that matches URLs starting with that host.
 */
export function registerAuthorizationEndpoint(url: string): void {
  try {
    const parsed = new URL(url);
    const escaped = parsed.hostname.replace(/\./g, '\\.');
    const pathEscaped = parsed.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    authorizationPatterns.push(
      new RegExp(`^https?://${escaped}${pathEscaped}`),
    );
  } catch {
    // Skip invalid URLs
  }
}

/** Check if a URL matches any known authorization endpoint. */
function isKnownAuthorizationUrl(url: string): boolean {
  return authorizationPatterns.some((re) => re.test(url));
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
  scope: string,
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

  if (!isKnownAuthorizationUrl(url)) {
    // Pass through — shim defaults to exit 0, tool thinks browser opened
    logger.debug({ url, scope }, 'browser-open: unknown URL, pass-through');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
    return;
  }

  logger.info({ url, scope }, 'browser-open: known OAuth URL, relaying');

  if (_onBrowserOpen) {
    try {
      _onBrowserOpen({ url, scope });
    } catch (err) {
      logger.error({ err, scope }, 'browser-open: callback error');
    }
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ exit_code: 0 }));
}
