/**
 * Docker-based e2e test harness for the OAuth proxy system.
 *
 * Boots a real CredentialProxy with MITM, a mock upstream HTTPS server,
 * and runs commands in real Docker containers with iptables redirect.
 * All HTTPS traffic from the container goes through the proxy to the mock.
 */
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import forge from 'node-forge';

import {
  CredentialProxy,
  setUpstreamAgent,
  setProxyInstance,
} from '../credential-proxy.js';
import {
  setTestUpstreamAgent,
  setTokenFetch,
} from './universal-oauth-handler.js';
import {
  TokenSubstituteEngine,
  PersistentTokenResolver,
} from './token-substitute.js';
import { setTokenEngine } from './registry.js';
import { createHandler } from './universal-oauth-handler.js';
import { FlowQueue } from './flow-queue.js';
import {
  registerAuthorizationEndpoint,
  registerAuthorizationPattern,
  setBrowserOpenCallback,
  type BrowserOpenEvent,
} from './browser-open-handler.js';
import type { OAuthProvider, SubstituteConfig } from './oauth-types.js';
import { asGroupScope } from './oauth-types.js';
import type { TokenRole } from './token-substitute.js';
import {
  buildContainerArgs,
  buildVolumeMounts,
  snapshotContainerFiles,
} from '../container-runner.js';
import { allocateContainerIP, ensureNetwork } from './container-args.js';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { initCredentialStore } from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockRoute {
  pathPattern: RegExp;
  respond: (req: RecordedRequest) => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Self-signed cert generation (node-forge, same pattern as mitm-proxy.test.ts)
// ---------------------------------------------------------------------------

function createSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

// ---------------------------------------------------------------------------
// Mock Upstream HTTPS Server
// ---------------------------------------------------------------------------

export class MockUpstream {
  server: https.Server;
  port = 0;
  host: string;
  requests: RecordedRequest[] = [];
  private routes: MockRoute[] = [];

  constructor(host: string) {
    this.host = host;
    const { key, cert } = createSelfSignedCert();
    this.server = https.createServer({ key, cert }, async (req, res) => {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', resolve);
      });
      const recorded: RecordedRequest = {
        method: req.method || '',
        url: req.url || '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      this.requests.push(recorded);

      const route = this.routes.find((r) => r.pathPattern.test(recorded.url));
      if (route) {
        const resp = route.respond(recorded);
        res.writeHead(resp.status, {
          'content-type': 'application/json',
          ...resp.headers,
        });
        res.end(
          typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body),
        );
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  }

  /** Add a route. Later routes take priority (matched first-to-last, first match wins). */
  addRoute(route: MockRoute): void {
    this.routes.push(route);
  }

  /** Replace all routes. */
  setRoutes(routes: MockRoute[]): void {
    this.routes = routes;
  }

  clearRoutes(): void {
    this.routes = [];
  }

  clearRequests(): void {
    this.requests = [];
  }

  /** Get requests matching a path pattern. */
  getRequests(pathPattern?: RegExp): RecordedRequest[] {
    if (!pathPattern) return this.requests;
    return this.requests.filter((r) => pathPattern.test(r.url));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, this.host, () => {
        const addr = this.server.address() as net.AddressInfo;
        this.port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Docker helpers (extracted from scripts/test-transparent-proxy.ts)
// ---------------------------------------------------------------------------

export function detectProxyBind(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  try {
    const out = execSync('ip addr show docker0', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  throw new Error('docker0 interface not found');
}

export function isDockerAvailable(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function isImageAvailable(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} image inspect ${CONTAINER_IMAGE}`, {
      stdio: 'pipe',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OAuthE2EHarness
// ---------------------------------------------------------------------------

export class OAuthE2EHarness {
  mockUpstream: MockUpstream;
  proxy: CredentialProxy;
  tokenEngine: TokenSubstituteEngine;
  resolver: PersistentTokenResolver;
  flowQueue: FlowQueue;
  browserOpenEvents: BrowserOpenEvent[] = [];

  proxyPort = 0;
  proxyBind: string;
  private server: net.Server | null = null;
  private tmpDir: string;

  constructor() {
    this.proxyBind = detectProxyBind();
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-e2e-'));
    this.resolver = new PersistentTokenResolver();
    this.tokenEngine = new TokenSubstituteEngine(this.resolver);
    this.proxy = new CredentialProxy();
    this.mockUpstream = new MockUpstream(this.proxyBind);
    this.flowQueue = new FlowQueue();
  }

  async start(): Promise<void> {
    // 0. Initialize credential store, ensure Docker network, snapshot container files
    initCredentialStore();
    ensureNetwork();
    snapshotContainerFiles();

    // 1. Start mock upstream
    await this.mockUpstream.start();

    // 2. Trust mock upstream's self-signed cert for handler connections
    const agent = new https.Agent({ rejectUnauthorized: false });
    setTestUpstreamAgent(agent);
    setUpstreamAgent(agent);

    // 3a. Route token endpoint fetch() to mock upstream (self-signed cert)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const mockBase = `https://${this.mockUpstream.host}:${this.mockUpstream.port}`;
    setTokenFetch((input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : (input as Request).url,
      );
      return fetch(`${mockBase}${url.pathname}${url.search}`, init);
    });

    // 3. Wire global singletons so buildContainerArgs (which calls getProxy(),
    //     getTokenEngine(), etc.) uses our test instances
    setProxyInstance(this.proxy);
    setTokenEngine(this.tokenEngine);

    // 4. Wire browser-open callback to flow queue
    setBrowserOpenCallback((event) => {
      this.browserOpenEvents.push(event);
      const flowId = `${event.providerId}:browser-open`;
      this.flowQueue.push(
        {
          flowId,
          eventType: 'oauth-start',
          providerId: event.providerId,
          eventParam: event.url,
          replyFn: null,
        },
        'xdg-open shim',
      );
      return flowId;
    });

    // 5. Start proxy with MITM (rules must be registered before start for transparent mode log,
    //    but shouldIntercept is a live closure so late registration works too)
    this.server = await this.proxy.start({
      port: 0,
      host: this.proxyBind,
      enableTransparent: true,
    });
    const addr = this.server.address() as net.AddressInfo;
    this.proxyPort = addr.port;
  }

  async stop(): Promise<void> {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    setTokenFetch(globalThis.fetch);
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    await this.mockUpstream.stop();
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {}
  }

  /**
   * Register an OAuth provider's rules with the proxy.
   * Handlers are wrapped to redirect upstream connections to the mock server.
   */
  registerProvider(provider: OAuthProvider): void {
    for (const rule of provider.rules) {
      const realHandler = createHandler(provider, rule, this.tokenEngine);
      const mockHost = this.mockUpstream.host;
      const mockPort = () => this.mockUpstream.port;
      const wrappedHandler: import('../credential-proxy.js').HostHandler = (
        clientReq,
        clientRes,
        targetHost,
        targetPort,
        scope,
        sourceIP,
      ) => {
        // Patch clientReq.url preservation: the handler builds redirect URLs
        // from targetHost. We need the redirect to use the original hostname
        // (so the client goes back through the proxy), but the upstream
        // connection to use the mock. Temporarily stash original host.
        const origTargetHost = targetHost;
        // Override the handler's redirect URL construction by wrapping writeHead
        const origWriteHead = clientRes.writeHead.bind(clientRes);
        clientRes.writeHead = ((code: number, ...args: any[]) => {
          if (code === 307) {
            // Fix redirect Location to use original hostname, not mock
            const headers = args[0] as Record<string, string> | undefined;
            if (headers?.location?.includes(mockHost)) {
              headers.location = headers.location
                .replace(`${mockHost}:${mockPort()}`, origTargetHost)
                .replace(mockHost, origTargetHost);
            }
          }
          return origWriteHead(code, ...args);
        }) as typeof clientRes.writeHead;
        return realHandler(
          clientReq,
          clientRes,
          mockHost,
          mockPort(),
          scope,
          sourceIP,
        );
      };

      this.proxy.registerAnchoredRule(
        rule.anchor,
        rule.hostPattern ??
          new RegExp(`^${rule.anchor.replace(/\./g, '\\.')}$`),
        rule.pathPattern,
        wrappedHandler,
        provider.id,
      );
    }
  }

  /** Register an authorization endpoint URL for browser-open matching. */
  registerAuthEndpoint(url: string, providerId: string): void {
    registerAuthorizationEndpoint(url, providerId);
  }

  /** Register a regex authorization pattern for browser-open matching. */
  registerAuthPattern(pattern: RegExp, providerId: string): void {
    registerAuthorizationPattern(pattern, providerId);
  }

  /**
   * Store a real token and generate a format-preserving substitute.
   * Returns the substitute string.
   */
  storeToken(
    realToken: string,
    providerId: string,
    scope: string,
    config: SubstituteConfig,
    role: TokenRole = 'access',
  ): string {
    const substitute = this.tokenEngine.generateSubstitute(
      realToken,
      providerId,
      {},
      asGroupScope(scope),
      config,
      role,
    );
    if (!substitute)
      throw new Error(
        `Failed to generate substitute for ${realToken.slice(0, 10)}...`,
      );
    return substitute;
  }

  /**
   * Run a command inside a Docker container using the REAL buildContainerArgs
   * and buildVolumeMounts from container-runner.ts — same setup as production
   * containers (mounts, iptables, CA cert, xdg-open shim, credential injection).
   *
   * Overrides the entrypoint to run a custom command instead of the agent-runner.
   */
  async runInContainer(
    command: string,
    opts: {
      env?: Record<string, string>;
      timeoutMs?: number;
      scope?: string;
    } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const { env = {}, timeoutMs = 30_000, scope = 'e2e-test' } = opts;

    // Create a minimal RegisteredGroup for the real buildVolumeMounts
    const group = this.ensureGroupFolder(scope);

    // Use the real container setup from container-runner.ts
    const volumeMounts = buildVolumeMounts(group, false);
    const containerName = `nanoclaw-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // Allocate static IP before spawn — no post-spawn inspection needed.
    const { ip: containerIP, release: releaseIP } = allocateContainerIP(
      asGroupScope(scope),
      this.proxy,
    );

    const containerArgs = buildContainerArgs(
      volumeMounts,
      containerName,
      group,
      this.tokenEngine,
      containerIP,
    );

    // Override PROXY_PORT — buildContainerArgs uses CREDENTIAL_PROXY_PORT from config
    // but our test proxy is on a dynamic port.
    for (let i = 0; i < containerArgs.length; i++) {
      if (
        containerArgs[i] === '-e' &&
        containerArgs[i + 1]?.startsWith('PROXY_PORT=')
      ) {
        containerArgs[i + 1] = `PROXY_PORT=${this.proxyPort}`;
      }
    }

    // Mount a JS file at /tmp/dist/index.js and a no-op tsc shim.
    // The real entrypoint does: iptables → CA certs → tsc → setpriv → node /tmp/dist/index.js
    // By mounting a no-op tsc, the compile step succeeds instantly (exit 0) and
    // our bind-mounted index.js runs as the agent. Zero entrypoint changes needed.
    // UUID marker separates entrypoint noise from test output.
    // Unique filename per call — the entrypoint's `chmod -R a-w /tmp/dist`
    // propagates through the bind mount and makes the host file read-only.
    const runId = crypto.randomUUID().replace(/-/g, '');
    const marker = `__E2E_${runId}__`;
    const testScript = path.join(this.tmpDir, `e2e-index-${runId}.js`);
    fs.writeFileSync(
      testScript,
      `process.stdout.write(${JSON.stringify(marker + '\n')});\n` +
        `const { execSync } = require('child_process');\n` +
        `try { execSync(${JSON.stringify(command)}, { stdio: 'inherit', shell: '/bin/bash' }); }\n` +
        `catch (e) { process.exit(e.status || 1); }\n`,
    );

    // No-op tsc shim — entrypoint calls `npx tsc --outDir /tmp/dist` which
    // resolves to this. It does nothing; our mounted index.js is already in place.
    const noopTsc = path.join(this.tmpDir, `tsc-${runId}`);
    fs.writeFileSync(noopTsc, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const imageIdx = containerArgs.lastIndexOf(CONTAINER_IMAGE);
    containerArgs.splice(
      imageIdx,
      0,
      '-v',
      `${testScript}:/tmp/dist/index.js`,
      '-v',
      `${noopTsc}:/app/node_modules/.bin/tsc:ro`,
    );

    // Inject extra env vars from test
    for (const [k, v] of Object.entries(env)) {
      // Insert before the image name (last few args are: --entrypoint '' IMAGE /bin/bash -c ...)
      const imageIdx = containerArgs.indexOf(CONTAINER_IMAGE);
      containerArgs.splice(imageIdx, 0, '-e', `${k}=${v}`);
    }

    return new Promise((resolve) => {
      const proc = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdin.end();

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        try {
          execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${containerName}`, {
            stdio: 'pipe',
          });
        } catch {}
        proc.kill('SIGKILL');
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        releaseIP();
        // Extract only test output — everything after the UUID marker
        const markerIdx = stdout.indexOf(marker);
        const cleanStdout =
          markerIdx >= 0
            ? stdout.slice(markerIdx + marker.length + 1) // +1 for \n
            : stdout;
        resolve({ exitCode: code ?? 1, stdout: cleanStdout, stderr });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        releaseIP();
        resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
      });
    });
  }

  /**
   * Ensure a group folder exists with minimal structure for buildVolumeMounts.
   * Uses the real GROUPS_DIR so buildVolumeMounts resolves paths correctly.
   * Returns a RegisteredGroup-compatible object.
   */
  private ensureGroupFolder(
    scope: string,
  ): import('../types.js').RegisteredGroup {
    const groupDir = resolveGroupFolderPath(scope);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    // Minimal CLAUDE.md so the container has a valid group folder
    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(claudeMd, '# E2E Test Group\n');
    }

    // buildVolumeMounts also needs IPC dir, sessions dir, agent-runner-src
    const ipcDir = resolveGroupIpcPath(scope);
    fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

    const sessionsDir = path.join(DATA_DIR, 'sessions', scope, '.claude');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Agent-runner src — copy from container/agent-runner/src if not present
    const agentRunnerDst = path.join(
      DATA_DIR,
      'sessions',
      scope,
      'agent-runner-src',
    );
    const agentRunnerSrc = path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'src',
    );
    if (!fs.existsSync(agentRunnerDst) && fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, agentRunnerDst, { recursive: true });
    }

    return {
      name: `e2e-${scope}`,
      folder: scope,
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: false,
    };
  }

  /** Reset state between tests. */
  reset(): void {
    this.mockUpstream.clearRequests();
    this.mockUpstream.clearRoutes();
    this.browserOpenEvents = [];
    this.flowQueue = new FlowQueue();
    // Clear token state to prevent substitute collisions between tests.
    // Uses the same engine instance that handlers captured at registration.
    this.tokenEngine.revokeByScope(asGroupScope('e2e-test'));
    this.tokenEngine.revokeByScope(asGroupScope('group-a'));
    this.tokenEngine.revokeByScope(asGroupScope('group-b'));
  }
}
