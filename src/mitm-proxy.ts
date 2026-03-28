/**
 * MITM proxy for transparent credential injection into HTTPS traffic.
 *
 * Containers set https_proxy/http_proxy to this proxy. On CONNECT:
 *   - Host not in rules → tunnel. No TLS termination.
 *   - Host in rules → TLS terminate, then detect mode from full URL:
 *     - bearer-swap:     Swap Authorization header, pipe body untouched (hot path).
 *     - token-exchange:  Buffer body both ways, swap tokens.
 *     - authorize-stub:  Stub response, no upstream.
 *
 * Uses node-forge for on-demand cert generation with LRU caching.
 * The CA cert is persisted to disk so containers can trust it across restarts.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createServer as createTlsServer, TlsOptions } from 'tls';
import { connect as netConnect, Socket } from 'net';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';
import forge from 'node-forge';

import { logger } from './logger.js';
import {
  OAuthProviderConfig,
  detectMode,
  handleBearerSwap,
  handleTokenExchange,
  handleAuthorizeStub,
} from './oauth-interceptor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialRule {
  /** Header name to inject (e.g. "Authorization") */
  header: string;
  /** Header value (e.g. "Bearer ghp_xxx") */
  value: string;
  /** Optional: strip any existing value for this header before injecting */
  stripExisting?: boolean;
}

export interface MitmProxyOptions {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Set of hostnames to MITM (TLS-terminate). All others get TCP tunnel. */
  mitmHosts: Set<string>;
  /** Static credential injection rules (legacy, per-host header injection) */
  rules?: Map<string, CredentialRule[]>;
  /** OAuth provider configs for dynamic interception */
  oauthProviders?: OAuthProviderConfig[];
  /** Directory to store CA cert/key (default: ~/.config/nanoclaw/mitm-ca) */
  caDir?: string;
  /** Max cached host certs (default: 100) */
  certCacheSize?: number;
  /** Reject invalid upstream TLS certs (default: true). Set false for testing. */
  rejectUnauthorized?: boolean;
}

// ---------------------------------------------------------------------------
// CA certificate management
// ---------------------------------------------------------------------------

interface CaBundle {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  keyPem: string;
  certPem: string;
}

function getDefaultCaDir(): string {
  const home = process.env.HOME || '/tmp';
  return path.join(home, '.config', 'nanoclaw', 'mitm-ca');
}

function loadOrCreateCa(caDir: string): CaBundle {
  const keyPath = path.join(caDir, 'ca.key');
  const certPath = path.join(caDir, 'ca.crt');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const keyPem = fs.readFileSync(keyPath, 'utf-8');
    const certPem = fs.readFileSync(certPath, 'utf-8');
    return {
      key: forge.pki.privateKeyFromPem(keyPem),
      cert: forge.pki.certificateFromPem(certPem),
      keyPem,
      certPem,
    };
  }

  logger.info({ caDir }, 'Generating MITM CA certificate');
  fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + 10,
  );

  const attrs = [
    { name: 'commonName', value: 'NanoClaw MITM CA' },
    { name: 'organizationName', value: 'NanoClaw' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      cRLSign: true,
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certPem, { mode: 0o644 });

  return { key: keys.privateKey, cert, keyPem, certPem };
}

// ---------------------------------------------------------------------------
// LRU cert cache
// ---------------------------------------------------------------------------

class CertLruCache {
  private cache = new Map<string, { keyPem: string; certPem: string }>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(hostname: string): { keyPem: string; certPem: string } | undefined {
    const entry = this.cache.get(hostname);
    if (entry) {
      this.cache.delete(hostname);
      this.cache.set(hostname, entry);
    }
    return entry;
  }

  set(hostname: string, entry: { keyPem: string; certPem: string }): void {
    if (this.cache.has(hostname)) {
      this.cache.delete(hostname);
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(hostname, entry);
  }

  get size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Host cert generation
// ---------------------------------------------------------------------------

function generateHostCert(
  hostname: string,
  ca: CaBundle,
): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: 'subjectAltName',
      altNames: [
        /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
          ? { type: 7, ip: hostname }
          : { type: 2, value: hostname },
      ],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

// ---------------------------------------------------------------------------
// Shared MITM context (used by credential-proxy for transparent mode)
// ---------------------------------------------------------------------------

export interface MitmContext {
  /** Get or generate a TLS cert for a hostname (LRU-cached). */
  getHostCert(hostname: string): { keyPem: string; certPem: string };
  /** CA cert PEM (for mounting into containers). */
  caCertPem: string;
}

/**
 * Create a MITM context with CA and cert cache, without starting a server.
 * Used by credential-proxy.ts to handle transparent TLS connections.
 */
export function createMitmContext(
  caDir?: string,
  certCacheSize = 100,
): MitmContext {
  const ca = loadOrCreateCa(caDir || getDefaultCaDir());
  const certCache = new CertLruCache(certCacheSize);

  return {
    getHostCert(hostname: string) {
      let cached = certCache.get(hostname);
      if (!cached) {
        cached = generateHostCert(hostname, ca);
        certCache.set(hostname, cached);
        logger.debug(
          { hostname, cacheSize: certCache.size },
          'Generated host cert',
        );
      }
      return cached;
    },
    caCertPem: ca.certPem,
  };
}

// ---------------------------------------------------------------------------
// SNI parsing for transparent mode
// ---------------------------------------------------------------------------

/**
 * Parse the Server Name Indication (SNI) from a TLS ClientHello message.
 * Returns the hostname or null if not found / not a TLS handshake.
 */
export function parseSni(buf: Buffer): string | null {
  // Minimum TLS record: type(1) + version(2) + length(2) + handshake_type(1) = 6
  if (buf.length < 6) return null;
  // ContentType: Handshake = 0x16
  if (buf[0] !== 0x16) return null;

  // Record length
  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) return null;

  // HandshakeType: ClientHello = 0x01
  if (buf[5] !== 0x01) return null;

  // Skip: handshake_type(1) + length(3) + client_version(2) + random(32) = 38
  let offset = 5 + 1 + 3 + 2 + 32;
  if (offset + 1 > buf.length) return null;

  // Session ID (variable length)
  const sessionIdLen = buf[offset];
  offset += 1 + sessionIdLen;
  if (offset + 2 > buf.length) return null;

  // Cipher suites (variable length)
  const cipherSuitesLen = buf.readUInt16BE(offset);
  offset += 2 + cipherSuitesLen;
  if (offset + 1 > buf.length) return null;

  // Compression methods (variable length)
  const compressionLen = buf[offset];
  offset += 1 + compressionLen;
  if (offset + 2 > buf.length) return null;

  // Extensions length
  const extensionsLen = buf.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLen;
  if (extensionsEnd > buf.length) return null;

  // Walk extensions
  while (offset + 4 <= extensionsEnd) {
    const extType = buf.readUInt16BE(offset);
    const extLen = buf.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + extLen > extensionsEnd) return null;

    if (extType === 0x0000) {
      // SNI extension — server_name_list
      if (extLen < 2) return null;
      const listLen = buf.readUInt16BE(offset);
      let pos = offset + 2;
      const listEnd = offset + 2 + listLen;
      while (pos + 3 <= listEnd) {
        const nameType = buf[pos];
        const nameLen = buf.readUInt16BE(pos + 1);
        pos += 3;
        if (pos + nameLen > listEnd) return null;
        if (nameType === 0) {
          // host_name type
          return buf.subarray(pos, pos + nameLen).toString('ascii');
        }
        pos += nameLen;
      }
      return null;
    }

    offset += extLen;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Static rule forwarding (legacy path — no OAuth)
// ---------------------------------------------------------------------------

function forwardWithStaticRules(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  targetPort: number,
  rules: CredentialRule[],
  useTls: boolean,
  rejectUnauthorized: boolean,
): void {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: targetHost,
      'content-length': body.length,
    };

    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];

    for (const rule of rules) {
      if (rule.stripExisting) {
        delete headers[rule.header.toLowerCase()];
      }
      headers[rule.header.toLowerCase()] = rule.value;
    }

    const makeReq = useTls ? httpsRequest : httpRequest;
    const upstream = makeReq(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers,
        rejectUnauthorized,
      } as RequestOptions,
      (upRes) => {
        res.writeHead(upRes.statusCode!, upRes.headers);
        upRes.pipe(res);
      },
    );

    upstream.on('error', (err) => {
      logger.error(
        { err, host: targetHost, url: req.url },
        'MITM upstream error',
      );
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  });
}

// ---------------------------------------------------------------------------
// Request handler — dispatches to the correct mode
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  targetPort: number,
  useTls: boolean,
  rejectUnauthorized: boolean,
  staticRules: Map<string, CredentialRule[]>,
  oauthProviders: OAuthProviderConfig[],
): Promise<void> {
  const urlPath = req.url || '/';

  // Try OAuth mode detection first
  if (oauthProviders.length > 0) {
    const mode = detectMode(targetHost, urlPath, oauthProviders);

    if (mode) {
      switch (mode.mode) {
        case 'authorize-stub': {
          const result = await handleAuthorizeStub(
            req,
            res,
            targetHost,
            mode.provider,
          );
          if (result === 'stub') return;
          // 'forward' — fall through to bearer-swap (passthrough)
          await handleBearerSwap(
            req,
            res,
            targetHost,
            targetPort,
            mode.provider,
            useTls,
            rejectUnauthorized,
          );
          return;
        }
        case 'token-exchange':
          await handleTokenExchange(
            req,
            res,
            targetHost,
            targetPort,
            mode.provider,
            useTls,
            rejectUnauthorized,
          );
          return;
        case 'bearer-swap':
          await handleBearerSwap(
            req,
            res,
            targetHost,
            targetPort,
            mode.provider,
            useTls,
            rejectUnauthorized,
          );
          return;
      }
    }
  }

  // Fall back to static rules
  const rules = staticRules.get(targetHost) || [];
  forwardWithStaticRules(
    req,
    res,
    targetHost,
    targetPort,
    rules,
    useTls,
    rejectUnauthorized,
  );
}

// ---------------------------------------------------------------------------
// MITM Proxy
// ---------------------------------------------------------------------------

export function startMitmProxy(options: MitmProxyOptions): Promise<Server> {
  const host = options.host || '127.0.0.1';
  const caDir = options.caDir || getDefaultCaDir();
  const certCacheSize = options.certCacheSize || 100;
  const rejectUpstream = options.rejectUnauthorized ?? true;
  const staticRules = options.rules || new Map();
  const oauthProviders = options.oauthProviders || [];

  const ca = loadOrCreateCa(caDir);
  const certCache = new CertLruCache(certCacheSize);

  function getHostCert(hostname: string): { keyPem: string; certPem: string } {
    let cached = certCache.get(hostname);
    if (!cached) {
      cached = generateHostCert(hostname, ca);
      certCache.set(hostname, cached);
      logger.debug(
        { hostname, cacheSize: certCache.size },
        'Generated host cert',
      );
    }
    return cached;
  }

  return new Promise((resolve, reject) => {
    const server = createServer();
    const activeSockets = new Set<Socket>();

    server.on('connection', (socket: Socket) => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });

    const originalClose = server.close.bind(server);
    server.close = function (cb?: (err?: Error) => void) {
      for (const socket of activeSockets) socket.destroy();
      activeSockets.clear();
      return originalClose(cb);
    } as typeof server.close;

    // Handle plain HTTP requests (http_proxy usage)
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const targetUrl = new URL(req.url || '/', 'http://localhost');
      const targetHost = targetUrl.hostname;
      const targetPort = parseInt(targetUrl.port || '80');
      req.url = targetUrl.pathname + targetUrl.search;
      handleRequest(
        req,
        res,
        targetHost,
        targetPort,
        false,
        rejectUpstream,
        staticRules,
        oauthProviders,
      );
    });

    // Handle CONNECT for HTTPS
    server.on(
      'connect',
      (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        const [targetHost, targetPortStr] = (req.url || '').split(':');
        const targetPort = parseInt(targetPortStr || '443');

        if (!options.mitmHosts.has(targetHost)) {
          // Mode 1: TCP tunnel — no TLS termination
          const upstream = netConnect(targetPort, targetHost, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
          });
          upstream.on('error', (err) => {
            logger.debug({ err, host: targetHost }, 'MITM tunnel error');
            clientSocket.destroy();
          });
          clientSocket.on('error', () => upstream.destroy());
          return;
        }

        // TLS terminate — mode decided at request time from full URL
        const hostCert = getHostCert(targetHost);
        const tlsOptions: TlsOptions = {
          key: hostCert.keyPem,
          cert: hostCert.certPem,
          ca: [ca.certPem],
        };

        const mitmServer = createTlsServer(tlsOptions, (tlsSocket) => {
          const innerServer = createServer((innerReq, innerRes) => {
            handleRequest(
              innerReq,
              innerRes,
              targetHost,
              targetPort,
              true,
              rejectUpstream,
              staticRules,
              oauthProviders,
            );
          });
          innerServer.emit('connection', tlsSocket);
        });

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        mitmServer.emit('connection', clientSocket);
        if (head.length) clientSocket.unshift(head);
      },
    );

    server.on('error', (err) => {
      logger.error({ err }, 'MITM proxy server error');
    });

    server.listen(options.port, host, () => {
      logger.info(
        {
          port: options.port,
          host,
          mitmHosts: [...options.mitmHosts],
          oauthProviders: oauthProviders.map((p) => p.id),
          caDir,
        },
        'MITM proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Path to the CA certificate (for mounting into containers) */
export function getMitmCaCertPath(caDir?: string): string {
  return path.join(caDir || getDefaultCaDir(), 'ca.crt');
}
