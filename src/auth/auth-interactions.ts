/**
 * Auth-specific HTTP interaction endpoints.
 *
 * Handles interaction status polling, SSE routing, listing,
 * and the authorize-stub response for intercepted OAuth requests.
 */
import type { IncomingMessage, ServerResponse } from 'http';

import type { InteractionStatusRegistry } from '../interaction/status.js';

/**
 * Write the authorize-stub JSON response for an intercepted OAuth request.
 * Includes interactionId and tracking URLs when available.
 */
export function writeInterceptStub(
  res: ServerResponse,
  authUrl: string,
  interactionId: string | null,
): void {
  const encodedId = interactionId ? encodeURIComponent(interactionId) : null;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'intercepted',
      message:
        'OAuth authorization URL intercepted by proxy and queued for user authentication',
      url: authUrl,
      ...(interactionId && {
        interactionId,
        statusUrl: `/interaction/${encodedId}/status`,
        eventsUrl: `/interaction/${encodedId}/events`,
      }),
    }),
  );
}

/**
 * Handle GET /interaction/{id}/status — simple polling endpoint.
 *
 * HTTP 200 = completed, 202 = in progress, 410 = failed/removed, 404 = unknown.
 */
function handleStatus(
  registry: InteractionStatusRegistry,
  interactionId: string,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const evts = registry.events(interactionId);
  const last = evts.length > 0 ? evts[evts.length - 1] : null;

  res.setHeader('content-type', 'application/json');
  if (!last) {
    res.writeHead(404);
    res.end(JSON.stringify({ state: 'unknown' }));
  } else if (last.state === 'completed') {
    res.writeHead(200);
    res.end(JSON.stringify({ state: last.state, message: last.explanation }));
  } else if (last.state === 'failed' || last.state === 'removed') {
    res.writeHead(410);
    res.end(JSON.stringify({ state: last.state, message: last.explanation }));
  } else {
    res.writeHead(202);
    res.end(JSON.stringify({ state: last.state, message: last.explanation }));
  }
}

/**
 * Route an interaction HTTP request to the appropriate handler.
 * Returns true if the request was handled.
 */
export function routeInteractionRequest(
  registry: InteractionStatusRegistry,
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (url.startsWith('/interaction/') && url.endsWith('/status') && method === 'GET') {
    const id = decodeURIComponent(url.slice('/interaction/'.length, -'/status'.length));
    handleStatus(registry, id, req, res);
    return true;
  }
  if (url.startsWith('/interaction/') && url.endsWith('/events') && method === 'GET') {
    const id = decodeURIComponent(url.slice('/interaction/'.length, -'/events'.length));
    registry.handleSSE(id, req, res);
    return true;
  }
  if (url === '/interactions' && method === 'GET') {
    registry.handleListInteractions(req, res);
    return true;
  }
  return false;
}
