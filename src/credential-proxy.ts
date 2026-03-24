/**
 * Credential proxy for container isolation.
 *
 * Two modes of operation:
 *   1. Transparent (iptables redirect): Raw TLS connections arrive on the
 *      proxy port. transparent-proxy.ts dispatches by first byte (TLS vs HTTP).
 *      TLS connections are MITM'd for registered hosts; others are TCP-tunneled.
 *   2. Explicit proxy (http_proxy/https_proxy): Containers set proxy env vars.
 *      CONNECT requests are MITM'd for registered hosts; others are tunneled.
 *      Plain HTTP requests are forwarded directly.
 *
 * Both modes validate callers by Docker bridge IP and reject unknown containers.
 * Credential injection happens only for registered host rules (transparent path)
 * or via CONNECT MITM (explicit proxy path). The proxy never modifies headers
 * on non-intercepted traffic — it's a plain tunnel for unregistered hosts.
 *
 * The HTTP server also serves internal endpoints (e.g. /health) for
 * host-to-guest communication.
 *
 * All mutable state lives in the CredentialProxy class so tests can create
 * isolated instances without cross-suite leakage.
 */
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  Server,
  ServerResponse,
} from 'http';
import { request as httpsRequest, RequestOptions } from 'https';
import { connect as netConnect, Socket } from 'net';
import { TLSSocket } from 'tls';
import type { Server as NetServer } from 'net';

import { logger } from './logger.js';
import { createMitmContext, type MitmContext } from './mitm-proxy.js';
import { createTransparentServer } from './transparent-proxy.js';

// ── Types ───────────────────────────────────────────────────────────

/**
 * Request handler for a host rule. Owns the full upstream round-trip:
 * credential resolution, header injection, body buffering (if needed),
 * and writing the response.
 */
export type HostHandler = (
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  scope: string,
) => Promise<void>;

/** Pluggable credential resolver. */
export type CredentialResolver = (scope: string) => Record<string, string>;

export type AuthMode = 'api-key' | 'oauth';

interface HostRule {
  hostPattern: RegExp;
  pathPattern: RegExp;
  handler: HostHandler;
}

interface MitmMeta {
  targetHost: string;
  targetPort: number;
  scope: string;
}

/** Options for the credential proxy. */
export interface CredentialProxyOptions {
  port: number;
  host?: string;
  /** Enable transparent MITM mode (iptables redirect). */
  enableTransparent?: boolean;
  /** Directory for MITM CA cert/key. */
  caDir?: string;
}

// ── Helpers (stateless) ─────────────────────────────────────────────

/** Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:172.17.0.2 → 172.17.0.2). */
function normalizeIP(raw: string): string {
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

type HeaderMap = Record<string, string | number | string[] | undefined>;

/**
 * HTTPS agent used by proxyPipe/proxyBuffered for upstream connections.
 * Default agent verifies server certificates (rejects self-signed).
 * Tests replace this with an agent that skips verification.
 */
let _upstreamAgent: import('https').Agent | undefined;

/** Replace the upstream HTTPS agent. Primarily for tests with self-signed certs. */
export function setUpstreamAgent(agent: import('https').Agent): void {
  _upstreamAgent = agent;
}

/**
 * Called when the upstream response is received, before the body is piped.
 * Sees request headers (post-injection) and response status/headers.
 * Body is NOT buffered — this is a headers-only hook on the streaming path.
 */
export type ProxyResponseHook = (info: {
  targetHost: string;
  targetPort: number;
  /** Scope of the container that made the request. */
  scope: string;
  method: string;
  path: string;
  requestHeaders: HeaderMap;
  statusCode: number;
  responseHeaders: import('http').IncomingHttpHeaders;
}) => void;

let _responseHook: ProxyResponseHook | null = null;

/** Set the response hook. Called once at startup. */
export function setProxyResponseHook(hook: ProxyResponseHook): void {
  _responseHook = hook;
}

/**
 * Forward a request to upstream HTTPS, piping the body straight through.
 *
 * NOTE: DNS resolution happens on the host, not using the container's resolver.
 * This means split-horizon DNS (e.g., hostnames only resolvable inside the
 * container's network) won't work. Using the original destination IP from
 * iptables (SO_ORIGINAL_DST) would fix this but is overkill for now.
 *
 * @param injectHeaders — mutate headers in place to add credentials.
 * @param scope — group scope (passed to response hook).
 */
export function proxyPipe(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  injectHeaders: (headers: HeaderMap) => void,
  scope = '',
): void {
  const headers: HeaderMap = { ...(clientReq.headers as Record<string, string>), host: targetHost };
  delete headers['connection'];
  delete headers['keep-alive'];
  injectHeaders(headers);

  const upstream = httpsRequest(
    { hostname: targetHost, port: targetPort, path: clientReq.url, method: clientReq.method, headers, agent: _upstreamAgent } as RequestOptions,
    (upRes) => {
      if (_responseHook) {
        _responseHook({
          targetHost,
          targetPort,
          scope,
          method: clientReq.method || '',
          path: clientReq.url || '',
          requestHeaders: headers,
          statusCode: upRes.statusCode!,
          responseHeaders: upRes.headers,
        });
      }
      clientRes.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(clientRes);
    },
  );
  upstream.on('error', (err) => {
    logger.error({ err, host: targetHost, url: clientReq.url }, 'proxyPipe upstream error');
    if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end('Bad Gateway'); }
  });
  clientReq.pipe(upstream);
}

/**
 * Forward a request to upstream HTTPS, buffering body both directions
 * so callers can transform request/response bodies (e.g. OAuth token exchange).
 * @param injectHeaders — mutate headers in place to add credentials.
 * @param transformRequest — transform request body before sending upstream.
 * @param transformResponse — transform response body before sending to client.
 *   Receives the body and HTTP status code. Only called for successful (2xx) responses.
 */
export async function proxyBuffered(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  injectHeaders: (headers: HeaderMap) => void,
  transformRequest: (body: string) => string,
  transformResponse: (body: string, statusCode: number) => string,
): Promise<void> {
  // Buffer request body
  const reqChunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    clientReq.on('data', (c) => reqChunks.push(c));
    clientReq.on('end', resolve);
  });
  const reqBody = transformRequest(Buffer.concat(reqChunks).toString());
  const reqBuf = Buffer.from(reqBody);

  const headers: HeaderMap = {
    ...(clientReq.headers as Record<string, string>),
    host: targetHost,
    'content-length': reqBuf.length,
  };
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  injectHeaders(headers);

  await new Promise<void>((resolve) => {
    const upstream = httpsRequest(
      { hostname: targetHost, port: targetPort, path: clientReq.url, method: clientReq.method, headers, agent: _upstreamAgent } as RequestOptions,
      async (upRes) => {
        const resChunks: Buffer[] = [];
        await new Promise<void>((r) => {
          upRes.on('data', (c: Buffer) => resChunks.push(c));
          upRes.on('end', r);
        });
        let resBody = Buffer.concat(resChunks).toString();
        const status = upRes.statusCode!;

        if (status >= 200 && status < 300) {
          try { resBody = transformResponse(resBody, status); }
          catch (err) { logger.error({ err, host: targetHost }, 'proxyBuffered transformResponse error'); }
        }

        const resBuf = Buffer.from(resBody);
        const resHeaders = { ...upRes.headers, 'content-length': String(resBuf.length) };
        delete resHeaders['transfer-encoding'];
        clientRes.writeHead(status, resHeaders);
        clientRes.end(resBuf);
        resolve();
      },
    );
    upstream.on('error', (err) => {
      logger.error({ err, host: targetHost, url: clientReq.url }, 'proxyBuffered upstream error');
      if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end('Bad Gateway'); }
      resolve();
    });
    upstream.write(reqBuf);
    upstream.end();
  });
}

// ── CredentialProxy class ───────────────────────────────────────────

export class CredentialProxy {
  /**
   * Anchor-indexed rules: domain suffix → rules for that anchor.
   * Lookup walks domain parts from 2-part suffix upward:
   *   "myco.auth0.com" → tries "auth0.com", then "myco.auth0.com"
   */
  private anchorRules = new Map<string, HostRule[]>();
  private containerIpToScope = new Map<string, string>();
  private _credentialResolver: CredentialResolver = () => ({});
  private _mitmCtx: MitmContext | null = null;

  /**
   * Shared HTTP server for dispatching all MITM'd requests (both transparent
   * and CONNECT paths). A single server avoids per-connection server creation
   * and its associated memory leak. Per-connection metadata (target host, port,
   * scope) is stashed in a WeakMap keyed on the socket.
   */
  private mitmDispatcher: Server;
  private socketMeta = new WeakMap<object, MitmMeta>();

  constructor() {
    this.mitmDispatcher = createServer((req, res) => {
      const meta = this.socketMeta.get(req.socket);
      if (!meta) {
        logger.error({ url: req.url }, 'MITM request with no socket metadata');
        res.writeHead(500);
        res.end('Internal error');
        return;
      }
      const handler = this.matchHostRule(meta.targetHost, req.url || '/');
      if (handler) {
        handler(req, res, meta.targetHost, meta.targetPort, meta.scope).catch((err) => {
          logger.error({ err, host: meta.targetHost }, 'MITM handler error');
          if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
        });
      } else {
        // Intercepted host but no path-specific handler — pipe unmodified
        proxyPipe(req, res, meta.targetHost, meta.targetPort, () => {}, meta.scope);
      }
    });
  }

  // ── State management ────────────────────────────────────────────

  setCredentialResolver(resolver: CredentialResolver): void {
    this._credentialResolver = resolver;
  }

  getCredentials(scope: string): Record<string, string> {
    return this._credentialResolver(scope);
  }

  registerContainerIP(ip: string, scope: string): void {
    this.containerIpToScope.set(ip, scope);
    logger.debug({ ip, scope }, 'Registered container IP');
  }

  unregisterContainerIP(ip: string): void {
    this.containerIpToScope.delete(ip);
    logger.debug({ ip }, 'Unregistered container IP');
  }

  /**
   * Register a host rule with its request handler.
   * Derives the anchor from the hostPattern source (strips regex anchors/escapes
   * to extract the domain). For exact-host patterns like /^api\.anthropic\.com$/,
   * the anchor is the hostname itself.
   */
  registerProviderHost(
    hostPattern: RegExp,
    pathPattern: RegExp,
    handler: HostHandler,
  ): void {
    // Derive anchor from regex source: strip ^, $, unescape dots
    const anchor = hostPattern.source
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\\\./g, '.');
    this.registerAnchoredRule(anchor, hostPattern, pathPattern, handler);
  }

  /**
   * Register a host rule under a domain anchor for fast lookup.
   * The anchor is a domain suffix (e.g. "auth0.com" for "*.auth0.com")
   * or an exact host (e.g. "api.anthropic.com").
   */
  registerAnchoredRule(
    anchor: string,
    hostPattern: RegExp,
    pathPattern: RegExp,
    handler: HostHandler,
  ): void {
    let rules = this.anchorRules.get(anchor);
    if (!rules) {
      rules = [];
      this.anchorRules.set(anchor, rules);
    }
    rules.push({ hostPattern, pathPattern, handler });
    logger.debug(
      { anchor, hostPattern: hostPattern.source, pathPattern: pathPattern.source },
      'Registered anchored host rule',
    );
  }

  // ── Queries ─────────────────────────────────────────────────────

  /**
   * Find the matching anchor for a hostname by walking domain parts.
   * "myco.auth0.com" → tries "auth0.com", then "myco.auth0.com".
   * Returns the rules array if found, null otherwise.
   */
  private findAnchorRules(targetHost: string): HostRule[] | null {
    // Exact match first
    const exact = this.anchorRules.get(targetHost);
    if (exact) return exact;

    // Walk domain parts from 2-part suffix upward
    const parts = targetHost.split('.');
    for (let i = parts.length - 2; i >= 1; i--) {
      const suffix = parts.slice(i).join('.');
      const rules = this.anchorRules.get(suffix);
      if (rules) return rules;
    }

    return null;
  }

  /** Should this hostname be TLS-terminated? O(parts) domain walk. */
  shouldIntercept(targetHost: string): boolean {
    return this.findAnchorRules(targetHost) !== null;
  }

  /**
   * Resolve scope from a container's source IP.
   * Returns null for unknown IPs — callers must reject the connection.
   */
  resolveScope(sourceIP: string): string | null {
    const ip = normalizeIP(sourceIP);
    const scope = this.containerIpToScope.get(ip);
    if (!scope) {
      logger.warn({ remoteIP: ip }, 'Connection from unknown container IP, rejecting');
      return null;
    }
    return scope;
  }

  /**
   * Find the handler for a request by matching host + path against rules.
   * Uses anchor lookup (O(1) domain-part walk) then regex match within the bucket.
   * Returns null if no rule matches.
   */
  matchHostRule(targetHost: string, urlPath: string): HostHandler | null {
    const rules = this.findAnchorRules(targetHost);
    if (!rules) return null;
    const rule = rules.find(r => r.hostPattern.test(targetHost) && r.pathPattern.test(urlPath));
    return rule?.handler ?? null;
  }

  getMitmContext(): MitmContext | null {
    return this._mitmCtx;
  }

  detectAuthMode(scope: string): AuthMode {
    const secrets = this._credentialResolver(scope);
    return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  }

  // ── MITM dispatch ───────────────────────────────────────────────

  /**
   * Emit a TLS socket into the shared MITM HTTP server with connection metadata.
   * Called by both the transparent proxy and the CONNECT handler.
   */
  emitMitmConnection(
    socket: object,
    targetHost: string,
    targetPort: number,
    scope: string,
  ): void {
    this.socketMeta.set(socket, { targetHost, targetPort, scope });
    this.mitmDispatcher.emit('connection', socket);
  }

  // ── Caller validation ───────────────────────────────────────────

  private validateCaller(remoteAddress: string | undefined): string | null {
    const ip = normalizeIP(remoteAddress || '');
    return this.containerIpToScope.get(ip) ?? null;
  }

  // ── Server ──────────────────────────────────────────────────────

  start(opts: CredentialProxyOptions): Promise<NetServer> {
    const port = opts.port;
    const bindHost = opts.host || '127.0.0.1';
    const enableTransparent = opts.enableTransparent ?? false;

    if (enableTransparent) {
      this._mitmCtx = createMitmContext(opts.caDir);
    }

    // HTTP server handles:
    // - Internal endpoints (/health) — no caller validation
    // - Plain HTTP proxy requests (explicit proxy mode) — caller validated
    // - Non-TLS traffic from transparent mode (first-byte detection)
    const httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const scope = this.validateCaller(req.socket.remoteAddress);
      if (!scope) {
        logger.warn(
          { remoteIP: normalizeIP(req.socket.remoteAddress || ''), url: req.url },
          'Rejecting HTTP request from unknown container IP',
        );
        res.writeHead(403);
        res.end('Forbidden: unknown container');
        return;
      }

      // Standard HTTP proxy: forward the request to the target URL.
      // No credential injection — plain proxy for non-intercepted traffic.
      const targetUrl = new URL(req.url || '/', 'http://localhost');
      const upstream = httpRequest(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers: { ...req.headers, host: targetUrl.host },
        },
        (upRes) => {
          res.writeHead(upRes.statusCode!, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        logger.error({ err, url: req.url }, 'HTTP proxy upstream error');
        if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
      });
      req.pipe(upstream);
    });

    // CONNECT handler: standard HTTPS proxy with MITM for registered hosts.
    httpServer.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      const scope = this.validateCaller(clientSocket.remoteAddress);
      if (!scope) {
        logger.warn(
          { remoteIP: normalizeIP(clientSocket.remoteAddress || ''), target: req.url },
          'Rejecting CONNECT from unknown container IP',
        );
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const [targetHost, targetPortStr] = (req.url || '').split(':');
      const targetPort = parseInt(targetPortStr || '443');

      if (!this._mitmCtx || !this.shouldIntercept(targetHost)) {
        // No MITM — plain TCP tunnel (no header inspection or modification)
        const upstream = netConnect(targetPort, targetHost, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
        });
        upstream.on('error', (err) => {
          logger.debug({ err, host: targetHost }, 'CONNECT tunnel error');
          clientSocket.destroy();
        });
        clientSocket.on('error', () => upstream.destroy());
        return;
      }

      // MITM: TLS-terminate, dispatch per-request via shared mitmDispatcher
      const hostCert = this._mitmCtx.getHostCert(targetHost);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      const tlsSocket = new TLSSocket(clientSocket, {
        isServer: true,
        key: hostCert.keyPem,
        cert: hostCert.certPem,
      });

      if (head.length) clientSocket.unshift(head);

      tlsSocket.on('error', (err) => {
        logger.debug({ err, hostname: targetHost }, 'CONNECT TLS error');
        clientSocket.destroy();
      });

      this.emitMitmConnection(tlsSocket, targetHost, targetPort, scope);
    });

    return new Promise((resolve, reject) => {
      if (!enableTransparent) {
        httpServer.listen(port, bindHost, () => {
          const hosts = [...this.anchorRules.keys()];
          logger.info({ port, host: bindHost, interceptHosts: hosts }, 'Credential proxy started');
          resolve(httpServer);
        });
        httpServer.on('error', reject);
        return;
      }

      // Transparent mode: wrap HTTP server with TLS-aware net.Server
      const server = createTransparentServer({
        httpServer,
        mitmCtx: this._mitmCtx!,
        shouldIntercept: (h) => this.shouldIntercept(h),
        resolveScope: (ip) => this.resolveScope(ip),
        emitMitmConnection: (s, h, p, sc) => this.emitMitmConnection(s, h, p, sc),
      });

      server.listen(port, bindHost, () => {
        const hosts = [...this.anchorRules.keys()];
        logger.info(
          { port, host: bindHost, transparentHosts: hosts },
          'Credential proxy started (transparent mode)',
        );
        resolve(server);
      });
      server.on('error', reject);
    });
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: CredentialProxy | null = null;

/** Set the global proxy instance (called once at startup). */
export function setProxyInstance(proxy: CredentialProxy): void {
  _instance = proxy;
}

/**
 * Get the global proxy instance.
 * Modules that can't receive the instance via parameters use this.
 */
export function getProxy(): CredentialProxy {
  if (!_instance) throw new Error('CredentialProxy not initialized — call setProxyInstance() first');
  return _instance;
}
