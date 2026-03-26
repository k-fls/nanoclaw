/**
 * JSONL logger for proxy traffic — logs HTTP request/response URLs + headers.
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

const LOG_FILE = path.join(DATA_DIR, 'proxy-tap.jsonl');

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
      headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
    }
  }

  // Request: "METHOD /path HTTP/1.1"
  const reqMatch = startLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\//);
  if (reqMatch) {
    return { kind: 'request', startLine, headers, method: reqMatch[1], url: reqMatch[2] };
  }

  // Response: "HTTP/1.1 STATUS REASON"
  const resMatch = startLine.match(/^HTTP\/\S+\s+(\d+)/);
  if (resMatch) {
    return { kind: 'response', startLine, headers, statusCode: parseInt(resMatch[1], 10) };
  }

  return null;
}

/**
 * Create a ProxyTapCallback that parses HTTP heads and writes JSONL.
 */
function createTapCallback(
  fd: number,
  host: string,
  scope: string,
  pathRe: RegExp,
): ProxyTapCallback {
  // Per-direction buffer — accumulate until headers are complete.
  const bufs: Record<string, string> = { inbound: '', outbound: '' };
  const emitted: Record<string, boolean> = { inbound: false, outbound: false };
  let pathMatched = false;

  return (event: ProxyTapEvent) => {
    const { direction, chunk } = event;
    if (direction === 'close') return;
    if (emitted[direction]) return; // already logged this direction's head

    bufs[direction] += chunk.toString('utf-8');
    const parsed = parseHead(bufs[direction]);
    if (!parsed) return; // headers not yet complete

    emitted[direction] = true;
    bufs[direction] = ''; // free memory

    // Apply path filter on the request; skip both request and response if no match
    if (parsed.kind === 'request') {
      pathMatched = !parsed.url || pathRe.test(parsed.url);
    }
    if (!pathMatched) return;

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
