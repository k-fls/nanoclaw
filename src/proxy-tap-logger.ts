/**
 * JSONL logger for proxy traffic — logs HTTP request/response URLs, headers, and bodies.
 *
 * Activated by two env vars:
 *   PROXY_TAP_DOMAIN  — hostname filter (substring match, e.g. "anthropic.com")
 *   PROXY_TAP_PATH    — path regex filter (e.g. "/v1/messages")
 *
 * Writes to data/proxy-tap.jsonl. Each line is a JSON object:
 *   { ts, scope, host, direction, method?, url?, statusCode?, headers }
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type {
  ProxyTapFilter,
  ProxyTapResolver,
  ProxyTapCallback,
  ProxyTapEvent,
} from './credential-proxy.js';
import { logger } from './logger.js';

export const LOG_FILE = path.join(DATA_DIR, 'proxy-tap.jsonl');

// ---------------------------------------------------------------------------
// Active tap state (for status reporting via /tap command)
// ---------------------------------------------------------------------------

let _activeTap: { domain: string; path: string } | null = null;

/** Returns the current tap filter config, or null if inactive. */
export function getActiveTap(): { domain: string; path: string } | null {
  return _activeTap;
}

/** Clear the active tap state. */
export function clearActiveTap(): void {
  _activeTap = null;
}

// ---------------------------------------------------------------------------
// Tap log reading (for /tap list command)
// ---------------------------------------------------------------------------

/**
 * Redact long alphanumeric+separator tokens in a string.
 * Any sequence of [a-zA-Z0-9_\-./+=] longer than 15 chars becomes
 * first-5 + "…" + last-5.
 */
function redactLongTokens(s: string): string {
  return s.replace(
    /[a-zA-Z0-9_\-./+=]{16,}/g,
    (m) => m.slice(0, 5) + '…' + m.slice(-5),
  );
}

/** Format a single tap log entry for display. */
function formatTapEntry(line: string): string | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const ts = String(entry.ts ?? '')
    .replace(/T/, ' ')
    .replace(/\.\d+Z$/, 'Z');
  const dir = entry.direction === 'outbound' ? '→' : '←';
  const scope = entry.scope ? ` [${entry.scope}]` : '';

  // Body entry
  if (entry.type === 'body') {
    let body = '';
    if (typeof entry.body === 'string') {
      try {
        body = Buffer.from(entry.body, 'base64').toString('utf-8');
      } catch {
        body = entry.body;
      }
    }
    body = redactLongTokens(body);
    // Truncate long bodies for display
    if (body.length > 300) body = body.slice(0, 300) + '…';
    const label = entry.method
      ? `${entry.method} ${entry.url ?? ''}`
      : `${entry.statusCode ?? ''}`;
    return `${ts} ${dir}${scope} BODY ${label}\n${body}`;
  }

  // Header entry
  const method = entry.method ? `${entry.method} ` : '';
  const url = entry.url ?? '';
  const status = entry.statusCode != null ? `${entry.statusCode} ` : '';
  const host = entry.host ?? '';

  let headerStr = '';
  if (entry.headers && typeof entry.headers === 'object') {
    const hdrs = entry.headers as Record<string, string>;
    headerStr = Object.entries(hdrs)
      .map(([k, v]) => `  ${k}: ${redactLongTokens(v)}`)
      .join('\n');
  }

  return `${ts} ${dir}${scope} ${method}${status}${url} (${host})${headerStr ? '\n' + headerStr : ''}`;
}

/**
 * Read tap log entries.
 * @param mode  'head' or 'tail' (default: 'tail')
 * @param count Number of entries (default: 20)
 */
export function readTapLog(mode: 'head' | 'tail' = 'tail', count = 20): string {
  if (!fs.existsSync(LOG_FILE)) return 'No tap log file.';

  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return 'Tap log is empty.';

  const selected =
    mode === 'head' ? lines.slice(0, count) : lines.slice(-count);

  const formatted = selected
    .map(formatTapEntry)
    .filter((e): e is string => e !== null);

  if (formatted.length === 0) return 'No parseable entries.';

  const label =
    mode === 'head'
      ? `First ${formatted.length} of ${lines.length}`
      : `Last ${formatted.length} of ${lines.length}`;
  return `${label} entries:\n\n${formatted.join('\n\n')}`;
}

// Simple incremental HTTP parser for extracting request/response lines + headers
// from raw bytes. Accumulates chunks until headers are complete, emits once.

interface ParsedHead {
  /** 'request' or 'response' */
  kind: 'request' | 'response';
  /** e.g. "GET /v1/messages HTTP/1.1" or "HTTP/1.1 200 OK" */
  startLine: string;
  /** Parsed headers as key-value pairs (last value wins for duplicates). */
  headers: Record<string, string>;
  // Extracted fields for convenience:
  method?: string;
  url?: string;
  statusCode?: number;
}

function parseHead(raw: string): ParsedHead | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;

  const headerBlock = raw.slice(0, headerEnd);
  const lines = headerBlock.split('\r\n');
  const startLine = lines[0];
  if (!startLine) return null;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon > 0) {
      headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i]
        .slice(colon + 1)
        .trim();
    }
  }

  // Request: "METHOD /path HTTP/1.1"
  const reqMatch = startLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\//);
  if (reqMatch) {
    return {
      kind: 'request',
      startLine,
      headers,
      method: reqMatch[1],
      url: reqMatch[2],
    };
  }

  // Response: "HTTP/1.1 STATUS REASON"
  const resMatch = startLine.match(/^HTTP\/\S+\s+(\d+)/);
  if (resMatch) {
    return {
      kind: 'response',
      startLine,
      headers,
      statusCode: parseInt(resMatch[1], 10),
    };
  }

  return null;
}

/** Max body size to capture (prevent unbounded memory for large streaming responses). */
const MAX_BODY_CAPTURE = 64 * 1024; // 64 KB

/**
 * Create a ProxyTapCallback that parses HTTP heads + bodies and writes JSONL.
 */
function createTapCallback(
  fd: number,
  host: string,
  scope: string,
  pathRe: RegExp,
): ProxyTapCallback {
  // Per-direction state
  const bufs: Record<string, Buffer[]> = { inbound: [], outbound: [] };
  const headParsed: Record<string, ParsedHead | null> = {
    inbound: null,
    outbound: null,
  };
  const headEmitted: Record<string, boolean> = {
    inbound: false,
    outbound: false,
  };
  const bodyBufs: Record<string, Buffer[]> = { inbound: [], outbound: [] };
  const bodyLen: Record<string, number> = { inbound: 0, outbound: 0 };
  const expectedLen: Record<string, number> = { inbound: -1, outbound: -1 };
  const bodyEmitted: Record<string, boolean> = {
    inbound: false,
    outbound: false,
  };
  let pathMatched = false;

  function emitHead(direction: string, parsed: ParsedHead) {
    const entry = {
      ts: new Date().toISOString(),
      scope,
      host,
      direction,
      ...(parsed.method && { method: parsed.method }),
      ...(parsed.url && { url: parsed.url }),
      ...(parsed.statusCode != null && { statusCode: parsed.statusCode }),
      headers: parsed.headers,
    };
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    } catch {}
  }

  function emitBody(direction: string, parsed: ParsedHead, rawBody: Buffer) {
    let body: string;
    const isChunked = parsed.headers['transfer-encoding'] === 'chunked';

    // Strip chunked framing if present (hex-length\r\n...data...\r\n)
    let bodyBuf = rawBody;
    if (isChunked) {
      try {
        const dechunked: Buffer[] = [];
        let pos = 0;
        const raw = rawBody;
        while (pos < raw.length) {
          const lineEnd = raw.indexOf('\r\n', pos);
          if (lineEnd < 0) break;
          const chunkSize = parseInt(
            raw.subarray(pos, lineEnd).toString('ascii'),
            16,
          );
          if (chunkSize === 0) break;
          pos = lineEnd + 2;
          if (pos + chunkSize > raw.length) {
            dechunked.push(raw.subarray(pos));
            break;
          }
          dechunked.push(raw.subarray(pos, pos + chunkSize));
          pos = pos + chunkSize + 2; // skip trailing \r\n
        }
        bodyBuf = Buffer.concat(dechunked);
      } catch {
        // Fall through with raw body
      }
    }

    body = bodyBuf.toString('base64');

    const entry = {
      ts: new Date().toISOString(),
      scope,
      host,
      direction,
      type: 'body' as const,
      ...(parsed.method && { method: parsed.method }),
      ...(parsed.url && { url: parsed.url }),
      ...(parsed.statusCode != null && { statusCode: parsed.statusCode }),
      body,
    };
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    } catch {}
  }

  return (event: ProxyTapEvent) => {
    const { direction, chunk } = event;

    if (direction === 'close') {
      // On close, flush any partially accumulated body
      for (const dir of ['inbound', 'outbound']) {
        if (
          headParsed[dir] &&
          !bodyEmitted[dir] &&
          bodyLen[dir] > 0 &&
          pathMatched
        ) {
          bodyEmitted[dir] = true;
          emitBody(dir, headParsed[dir]!, Buffer.concat(bodyBufs[dir]));
        }
      }
      return;
    }

    // Phase 1: accumulate until headers are complete
    if (!headParsed[direction]) {
      // Ensure we have a real Buffer (not a string masquerading as one)
      const safeChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as unknown as string, 'latin1');
      bufs[direction].push(safeChunk);
      const fullBuf = Buffer.concat(bufs[direction]);
      const raw = fullBuf.toString('latin1');
      const parsed = parseHead(raw);
      if (!parsed) return; // headers not yet complete

      headParsed[direction] = parsed;

      // Extract body portion from the same buffer before freeing
      const headerEndByte = fullBuf.indexOf('\r\n\r\n');
      if (headerEndByte >= 0) {
        const bodyStart = headerEndByte + 4;
        if (bodyStart < fullBuf.length) {
          const bodyChunk = fullBuf.subarray(bodyStart);
          bodyBufs[direction].push(Buffer.from(bodyChunk));
          bodyLen[direction] += bodyChunk.length;
        }
      }
      bufs[direction] = []; // free header buffers

      // Apply path filter on the request
      if (parsed.kind === 'request') {
        pathMatched = !parsed.url || pathRe.test(parsed.url);
      }

      if (pathMatched && !headEmitted[direction]) {
        headEmitted[direction] = true;
        emitHead(direction, parsed);
      }

      // Determine expected body length from content-length header
      const cl = parsed.headers['content-length'];
      if (cl) {
        expectedLen[direction] = parseInt(cl, 10);
      }

      // Check if body is already complete
      if (
        expectedLen[direction] >= 0 &&
        bodyLen[direction] >= expectedLen[direction] &&
        pathMatched
      ) {
        bodyEmitted[direction] = true;
        emitBody(direction, parsed, Buffer.concat(bodyBufs[direction]));
      }
      return;
    }

    // Phase 2: accumulate body chunks
    if (bodyEmitted[direction]) return;
    if (bodyLen[direction] >= MAX_BODY_CAPTURE) {
      if (pathMatched) {
        bodyEmitted[direction] = true;
        emitBody(
          direction,
          headParsed[direction]!,
          Buffer.concat(bodyBufs[direction]),
        );
      }
      return;
    }

    const safeBodyChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as unknown as string, 'latin1');
    bodyBufs[direction].push(safeBodyChunk);
    bodyLen[direction] += safeBodyChunk.length;

    // Emit body when content-length is reached
    if (
      expectedLen[direction] >= 0 &&
      bodyLen[direction] >= expectedLen[direction] &&
      pathMatched
    ) {
      bodyEmitted[direction] = true;
      emitBody(
        direction,
        headParsed[direction]!,
        Buffer.concat(bodyBufs[direction]),
      );
    }
  };
}

/**
 * Build a ProxyTapFilter that logs to a JSONL file.
 * @param domainPattern  Regex matching target hostnames
 * @param pathPattern    Regex matching request paths
 * @param logFile        Output file path (appended)
 */
export function createTapFilter(
  domainPattern: RegExp,
  pathPattern: RegExp,
  logFile: string,
): ProxyTapFilter {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');

  _activeTap = { domain: domainPattern.source, path: pathPattern.source };

  logger.info(
    { domain: domainPattern.source, path: pathPattern.source, logFile },
    'Proxy tap logger activated',
  );

  return (hostname: string, _scope: string): ProxyTapResolver | null => {
    if (!domainPattern.test(hostname)) return null;
    return (targetHost: string, connScope: string): ProxyTapCallback | null => {
      return createTapCallback(fd, targetHost, connScope, pathPattern);
    };
  };
}

/**
 * Build a ProxyTapFilter from env vars. Returns null if not configured.
 *
 * Env vars:
 *   PROXY_TAP_DOMAIN — hostname regex (e.g. "anthropic\\.com")
 *   PROXY_TAP_PATH   — request path regex (e.g. "/v1/messages")
 */
export function createTapFilterFromEnv(): ProxyTapFilter | null {
  const domain = process.env.PROXY_TAP_DOMAIN;
  const pathPattern = process.env.PROXY_TAP_PATH;
  if (!domain || !pathPattern) return null;

  return createTapFilter(new RegExp(domain), new RegExp(pathPattern), LOG_FILE);
}
