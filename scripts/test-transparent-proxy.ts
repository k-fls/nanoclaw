#!/usr/bin/env npx tsx
/**
 * Integration test: Claude CLI through the transparent proxy.
 *
 * Starts the credential proxy in transparent mode, spawns real Docker containers
 * with iptables redirect (same as NanoClaw agent containers), and validates that
 * the proxy actually intercepts, handles, and forwards requests.
 *
 * Validation is proxy-side: we instrument the handlers with logging wrappers and
 * check the proxy event log — not client stdout string matching.
 *
 * Usage: npx tsx scripts/test-transparent-proxy.ts
 *
 * Prerequisites:
 *   - Docker running
 *   - nanoclaw-agent image built (./container/build.sh)
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server as NetServer } from 'net';

import {
  startCredentialProxy,
  registerContainerIP,
  unregisterContainerIP,
  registerProviderHost,
  setCredentialResolver,
  type HostHandler,
} from '../src/credential-proxy.js';
import { PLACEHOLDER_API_KEY, PLACEHOLDER_ACCESS_TOKEN, PLACEHOLDER_REFRESH_TOKEN } from '../src/auth/providers/claude.js';
import { getMitmCaCertPath } from '../src/mitm-proxy.js';
import { CONTAINER_RUNTIME_BIN, CONTAINER_HOST_GATEWAY, hostGatewayArgs } from '../src/container-runtime.js';
import { CONTAINER_IMAGE } from '../src/config.js';

// ── Local credentials ────────────────────────────────────────────────

const LOCAL_CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

interface LocalCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function loadLocalCreds(): LocalCreds {
  const raw = JSON.parse(fs.readFileSync(LOCAL_CREDS_PATH, 'utf-8'));
  const oauth = raw.claudeAiOauth ?? raw;
  if (!oauth.accessToken || !oauth.refreshToken) {
    throw new Error(`No OAuth tokens in ${LOCAL_CREDS_PATH}`);
  }
  return oauth;
}

// ── Proxy event log ──────────────────────────────────────────────────

interface ProxyEvent {
  timestamp: number;
  hostname: string;
  path: string;
  method: string;
  handler: string;
  scope: string;
  credentialKeys: string[];      // which secret keys were available
  upstreamStatus: number | null; // null if handler errored before upstream
}

const proxyEvents: ProxyEvent[] = [];

/** Clear events between tests. */
function clearProxyEvents(): void {
  proxyEvents.length = 0;
}

/** Find events matching a predicate. */
function findEvents(pred: (e: ProxyEvent) => boolean): ProxyEvent[] {
  return proxyEvents.filter(pred);
}

// ── Console output ───────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function logSection(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ── Instrumented proxy handlers ──────────────────────────────────────
//
// Instead of registering the real claudeProvider handlers directly, we
// register wrappers that record every request into proxyEvents[].
// The wrappers delegate to the real proxy plumbing (proxyPipe/proxyBuffered)
// so the behavior is identical — we just observe it.

import { proxyPipe, proxyBuffered } from '../src/credential-proxy.js';
import { injectClaudeCredentials } from '../src/auth/providers/claude.js';
import { replaceJsonStringValue } from '../src/oauth-interceptor.js';

/**
 * Instrumented handleApiHost — logs the event, then delegates to proxyPipe.
 */
const instrumentedApiHandler: HostHandler = async (
  clientReq, clientRes, targetHost, targetPort, scope,
) => {
  const secrets = resolverSecrets;
  const event: ProxyEvent = {
    timestamp: Date.now(),
    hostname: targetHost,
    path: clientReq.url || '/',
    method: clientReq.method || 'GET',
    handler: 'handleApiHost',
    scope,
    credentialKeys: Object.keys(secrets),
    upstreamStatus: null,
  };

  // Record immediately — upstream status will be filled in asynchronously
  proxyEvents.push(event);
  log(`  [proxy] handleApiHost ENTER: ${clientReq.method} ${targetHost}${clientReq.url}`);

  // Intercept the upstream response to record status
  const origWriteHead = clientRes.writeHead.bind(clientRes);
  clientRes.writeHead = function (statusCode: number, ...args: any[]) {
    event.upstreamStatus = statusCode;
    log(`  [proxy] handleApiHost upstream responded: ${statusCode}`);
    return origWriteHead(statusCode, ...args);
  } as typeof clientRes.writeHead;

  proxyPipe(clientReq, clientRes, targetHost, targetPort, (headers) => {
    injectClaudeCredentials(headers, secrets);
  });
};

/**
 * Instrumented handleOAuthTokenExchange — logs the event, then delegates to proxyBuffered.
 */
const instrumentedTokenExchangeHandler: HostHandler = async (
  clientReq, clientRes, targetHost, targetPort, scope,
) => {
  const secrets = resolverSecrets;
  const event: ProxyEvent = {
    timestamp: Date.now(),
    hostname: targetHost,
    path: clientReq.url || '/',
    method: clientReq.method || 'POST',
    handler: 'handleOAuthTokenExchange',
    scope,
    credentialKeys: Object.keys(secrets),
    upstreamStatus: null,
  };

  proxyEvents.push(event);
  log(`  [proxy] handleOAuthTokenExchange ENTER: ${clientReq.method} ${targetHost}${clientReq.url}`);

  try {
    await proxyBuffered(
      clientReq, clientRes, targetHost, targetPort,
      (headers) => { injectClaudeCredentials(headers, secrets); },
      (body) => {
        if (!secrets.CLAUDE_REFRESH_TOKEN) return body;
        try {
          const parsed = JSON.parse(body);
          if (parsed.grant_type === 'refresh_token' && parsed.refresh_token) {
            return replaceJsonStringValue(body, 'refresh_token', secrets.CLAUDE_REFRESH_TOKEN);
          }
        } catch {}
        return body;
      },
      (body, status) => {
        event.upstreamStatus = status;
        return body;
      },
    );
    log(`  [proxy] handleOAuthTokenExchange done: ${event.upstreamStatus ?? 'no-2xx'}`);
  } catch (err) {
    log(`  [proxy] handleOAuthTokenExchange error: ${err}`);
  }
};

// ── Credential resolver ──────────────────────────────────────────────

let resolverSecrets: Record<string, string> = {};

function setupLoggingResolver(): void {
  setCredentialResolver((scope: string) => {
    log(`  [proxy] Credential resolver called for scope: ${scope}`);
    return resolverSecrets;
  });
}

// ── Container helpers ────────────────────────────────────────────────

const PROXY_PORT = 13001;

function detectProxyBind(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find(a => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  // os.networkInterfaces() omits DOWN interfaces; parse ip addr directly
  try {
    const out = execSync('ip addr show docker0', { encoding: 'utf-8', timeout: 3000 });
    const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}

  throw new Error('docker0 interface not found — cannot bind proxy');
}
const PROXY_BIND = detectProxyBind();

/** Get container bridge IP via docker inspect (retries). */
function getContainerIP(containerName: string, maxAttempts = 10, delayMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryInspect = () => {
      attempt++;
      try {
        const ip = execSync(
          `${CONTAINER_RUNTIME_BIN} inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim().replace(/^'|'$/g, '');
        if (ip) return resolve(ip);
      } catch {}
      if (attempt < maxAttempts) setTimeout(tryInspect, delayMs);
      else resolve(null);
    };
    setTimeout(tryInspect, delayMs);
  });
}

interface AgentContainerOpts {
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  extraArgs?: string[];
}

/** Run a command in an agent-style container (bridge network + iptables redirect). */
async function runAgentContainer(opts: AgentContainerOpts): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { command, env = {}, timeoutMs = 60_000, extraArgs = [] } = opts;
  const caCertPath = getMitmCaCertPath();
  const containerName = `nanoclaw-test-${Date.now()}`;

  const args: string[] = [
    'run', '-i', '--rm',
    '--name', containerName,
    '--cap-add=NET_ADMIN',
    '-e', `PROXY_HOST=${CONTAINER_HOST_GATEWAY}`,
    '-e', `PROXY_PORT=${PROXY_PORT}`,
    '-v', `${caCertPath}:/usr/local/share/ca-certificates/nanoclaw-mitm.crt:ro`,
    '-e', 'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/nanoclaw-mitm.crt',
  ];

  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }

  args.push(...hostGatewayArgs());
  args.push(...extraArgs);

  args.push(
    '--entrypoint', '',
    CONTAINER_IMAGE,
    '/bin/bash', '-c',
    // iptables needs numeric IP — resolve hostname from /etc/hosts
    `PROXY_IP=$(getent hosts $PROXY_HOST | awk "{print \\$1}" || echo $PROXY_HOST) && ` +
    `iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination $PROXY_IP:$PROXY_PORT && ` +
    `update-ca-certificates 2>/dev/null && ` +
    command,
  );

  return new Promise(async (resolve) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // Close stdin so the CLI doesn't wait for input
    proc.stdin.end();

    // Register container IP so the proxy accepts its connections
    const containerIP = await getContainerIP(containerName);
    if (containerIP) {
      registerContainerIP(containerIP, 'default');
      log(`  Registered container IP ${containerIP}`);
    } else {
      log(`  WARNING: Could not get container IP — proxy will reject connections`);
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      log(`  Container ${containerName} timed out, killing...`);
      try { execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${containerName}`, { stdio: 'pipe' }); } catch {}
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (containerIP) unregisterContainerIP(containerIP);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (containerIP) unregisterContainerIP(containerIP);
      resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
    });
  });
}

// ── Prerequisites ────────────────────────────────────────────────────

function checkPrerequisites(): boolean {
  log('Checking prerequisites...');

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10_000 });
    log('  ✓ Docker is running');
  } catch {
    log('  ✗ Docker is not running');
    return false;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} image inspect ${CONTAINER_IMAGE}`, { stdio: 'pipe', timeout: 5_000 });
    log(`  ✓ Image ${CONTAINER_IMAGE} exists`);
  } catch {
    log(`  ✗ Image ${CONTAINER_IMAGE} not found — run ./container/build.sh first`);
    return false;
  }

  const caCertPath = getMitmCaCertPath();
  if (fs.existsSync(caCertPath)) {
    log(`  ✓ MITM CA cert at ${caCertPath}`);
  } else {
    log(`  ℹ MITM CA cert will be generated on proxy start`);
  }

  return true;
}

// ── Test scenarios ───────────────────────────────────────────────────

async function test1CurlSmoke(): Promise<boolean> {
  logSection('Test 1: curl through proxy (smoke test)');
  clearProxyEvents();
  resolverSecrets = {
    ANTHROPIC_API_KEY: 'sk-ant-api00-test-credential-injection',
  };

  const result = await runAgentContainer({
    command: `curl -s --max-time 15 -w '\\n%{http_code}' https://api.anthropic.com/v1/messages`,
    env: { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY },
    timeoutMs: 30_000,
  });

  log(`  Exit code: ${result.exitCode}`);

  // Extract HTTP status code from curl -w output (last line)
  const lines = result.stdout.trim().split('\n');
  const httpCode = parseInt(lines[lines.length - 1], 10);
  log(`  HTTP status from curl: ${httpCode || 'none (connection failed)'}`);

  // Proxy-side validation: did handleApiHost actually fire?
  const apiEvents = findEvents(e => e.handler === 'handleApiHost' && e.hostname === 'api.anthropic.com');

  const proxyHandled = apiEvents.length > 0;
  const gotHttpResponse = httpCode >= 100 && httpCode < 600;
  const upstreamResponded = apiEvents.some(e => e.upstreamStatus !== null);

  log(`  Proxy events for api.anthropic.com: ${apiEvents.length}`);
  if (proxyHandled) {
    log(`  ✓ PASS: Proxy handleApiHost fired`);
    if (upstreamResponded) {
      log(`  ✓ Upstream responded with ${apiEvents[0].upstreamStatus}`);
    } else {
      log(`  ⚠ Upstream status not yet captured (async piping)`);
    }
  } else {
    log(`  ✗ FAIL: Proxy never handled the request`);
  }

  if (gotHttpResponse) {
    log(`  ✓ Client received HTTP ${httpCode}`);
  } else {
    log(`  ✗ Client got no HTTP response (connection/TLS failure)`);
  }

  // Pass = proxy handled the request AND client got an HTTP response
  return proxyHandled && gotHttpResponse;
}

async function test2ClaudeCliOAuth(): Promise<boolean> {
  logSection('Test 2: claude -p "hi" with real OAuth credentials');
  clearProxyEvents();

  const creds = loadLocalCreds();
  resolverSecrets = {
    CLAUDE_CODE_OAUTH_TOKEN: creds.accessToken,
  };

  const result = await runAgentContainer({
    command: `claude -p "reply with the single word: pong" --verbose 2>&1 || true`,
    env: { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_ACCESS_TOKEN },
    timeoutMs: 90_000,
    extraArgs: [
      '-v', `${LOCAL_CREDS_PATH}:/root/.claude/.credentials.json:ro`,
    ],
  });

  log(`  Exit code: ${result.exitCode}`);
  for (const line of result.stdout.split('\n').slice(-40)) {
    if (line.trim()) log(`  stdout: ${line}`);
  }

  const messagesEvents = findEvents(e => e.path.includes('/v1/messages'));
  const allApiEvents = findEvents(e => e.handler === 'handleApiHost');

  log(`  Proxy /v1/messages events: ${messagesEvents.length}`);
  log(`  Proxy total API events: ${allApiEvents.length}`);
  for (const ev of messagesEvents) {
    log(`    → ${ev.method} ${ev.hostname}${ev.path} status=${ev.upstreamStatus}`);
  }

  const hitMessages = messagesEvents.length > 0;
  const got200 = messagesEvents.some(e => e.upstreamStatus === 200);
  const cliGotResponse = result.stdout.toLowerCase().includes('pong');

  if (hitMessages) {
    log(`  ✓ Proxy intercepted /v1/messages`);
  } else {
    log(`  ✗ FAIL: No /v1/messages request reached the proxy`);
  }

  if (got200) {
    log(`  ✓ Upstream returned 200`);
  } else {
    log(`  ⚠ No 200 from /v1/messages`);
  }

  if (cliGotResponse) {
    log(`  ✓ CLI received response ("pong" in output)`);
  } else {
    log(`  ⚠ CLI did not print expected response`);
  }

  return hitMessages;
}

async function test3OAuthTokenRefresh(): Promise<boolean> {
  logSection('Test 3: claude -p with expired access token (force refresh)');
  clearProxyEvents();

  // Strategy: give the CLI an expired access token (via env var + .credentials.json).
  // DON'T let the proxy inject a valid token — so upstream returns 401.
  // The CLI should then attempt to refresh at console.anthropic.com/api/oauth/token,
  // which the proxy intercepts. The proxy swaps the placeholder refresh_token for
  // the real one, so the refresh succeeds.
  const realCreds = JSON.parse(fs.readFileSync(LOCAL_CREDS_PATH, 'utf-8'));
  const creds = loadLocalCreds();

  // Only provide the refresh token — NO valid access token.
  // injectClaudeCredentials won't touch Authorization header without CLAUDE_CODE_OAUTH_TOKEN.
  resolverSecrets = {
    CLAUDE_REFRESH_TOKEN: creds.refreshToken,
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  const credsPath = path.join(tmpDir, '.credentials.json');
  const expiredCreds = JSON.parse(JSON.stringify(realCreds));
  expiredCreds.claudeAiOauth.expiresAt = Date.now() - 60_000; // expired 1 min ago
  expiredCreds.claudeAiOauth.accessToken = 'expired-placeholder-token';
  fs.writeFileSync(credsPath, JSON.stringify(expiredCreds));

  const result = await runAgentContainer({
    command: `claude -p "reply with the single word: pong" --verbose 2>&1 || true`,
    // No env var — CLI reads .credentials.json, sees expired token, should attempt refresh
    env: {},
    timeoutMs: 90_000,
    extraArgs: ['-v', `${credsPath}:/root/.claude/.credentials.json:ro`],
  });

  try { fs.unlinkSync(credsPath); fs.rmdirSync(tmpDir); } catch {}

  log(`  Exit code: ${result.exitCode}`);
  for (const line of result.stdout.split('\n').slice(-40)) {
    if (line.trim()) log(`  stdout: ${line}`);
  }

  const tokenExchangeEvents = findEvents(e => e.handler === 'handleOAuthTokenExchange');
  const messagesEvents = findEvents(e => e.path.includes('/v1/messages'));
  const allApiEvents = findEvents(e => e.handler === 'handleApiHost');

  log(`  Proxy token-exchange events: ${tokenExchangeEvents.length}`);
  log(`  Proxy /v1/messages events: ${messagesEvents.length}`);
  log(`  Proxy total API events: ${allApiEvents.length}`);

  for (const ev of tokenExchangeEvents) {
    log(`    → ${ev.method} ${ev.hostname}${ev.path} status=${ev.upstreamStatus}`);
  }

  if (tokenExchangeEvents.length > 0) {
    log(`  ✓ CLI attempted token refresh via console.anthropic.com`);
  } else {
    log(`  ✗ FAIL: No token-exchange request reached the proxy`);
  }

  if (messagesEvents.length > 0) {
    log(`  ✓ CLI called /v1/messages after refresh`);
  }

  return tokenExchangeEvents.length > 0;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logSection('Transparent Proxy Integration Test');

  if (!checkPrerequisites()) {
    process.exit(1);
  }

  // Register instrumented handlers (not the real provider — we want to observe)
  log('\nRegistering instrumented proxy handlers...');
  registerProviderHost(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, instrumentedTokenExchangeHandler);
  registerProviderHost(/^api\.anthropic\.com$/, /^\//, instrumentedApiHandler);
  setupLoggingResolver();

  log(`Starting credential proxy on ${PROXY_BIND}:${PROXY_PORT} (transparent mode)...`);
  let server: NetServer;
  try {
    server = await startCredentialProxy({
      port: PROXY_PORT,
      host: PROXY_BIND,
      enableTransparent: true,
    });
    log('  ✓ Proxy started\n');
  } catch (err) {
    log(`  ✗ Failed to start proxy: ${err}`);
    process.exit(1);
  }

  const tests: Array<[string, () => Promise<boolean>]> = [
    ['curl through proxy', test1CurlSmoke],
    ['claude -p with OAuth', test2ClaudeCliOAuth],
    ['claude -p with expired token (force refresh)', test3OAuthTokenRefresh],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    const ok = await fn();
    if (!ok) {
      log(`\n✗ FAIL: "${name}" — stopping.\n`);
      server.close();
      process.exit(1);
    }
    passed++;
  }

  log(`\n✓ All ${passed}/${tests.length} tests passed.\n`);
  server.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
