#!/usr/bin/env npx tsx
/**
 * Interactive test: claude auth login through the transparent proxy.
 *
 * 1. Starts the credential proxy in transparent mode
 * 2. Spawns a container with bridge network + iptables redirect
 * 3. Runs `claude auth login` inside
 * 4. Captures the OAuth URL → writes to /tmp/oauth-url.txt
 * 5. Polls for /tmp/callback-url.txt (you write the callback URL there)
 * 6. Delivers callback via docker exec
 * 7. Waits for CLI to finish, reports proxy events
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
import { getMitmCaCertPath } from '../src/mitm-proxy.js';
import { CONTAINER_RUNTIME_BIN, CONTAINER_HOST_GATEWAY, hostGatewayArgs } from '../src/container-runtime.js';
import { CONTAINER_IMAGE } from '../src/config.js';
import { proxyBuffered } from '../src/credential-proxy.js';

/** Strip accept-encoding so upstream sends uncompressed (proxyBuffered can't handle gzip). */
function stripEncoding(headers: Record<string, string | number | string[] | undefined>): void {
  delete headers['accept-encoding'];
}

/** Log body (truncated for readability, full for small bodies). */
function logBody(label: string, body: string): void {
  if (body.length <= 2000) {
    log(`  [proxy] ${label} body: ${body}`);
  } else {
    log(`  [proxy] ${label} body (${body.length} bytes): ${body.slice(0, 1000)}...`);
  }
}

// ── Proxy event log ──────────────────────────────────────────────────

interface ProxyEvent {
  timestamp: number;
  hostname: string;
  path: string;
  method: string;
  handler: string;
  upstreamStatus: number | null;
}

const proxyEvents: ProxyEvent[] = [];

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

// ── Instrumented handlers ────────────────────────────────────────────

const instrumentedApiHandler: HostHandler = async (
  clientReq, clientRes, targetHost, targetPort, scope,
) => {
  const event: ProxyEvent = {
    timestamp: Date.now(),
    hostname: targetHost,
    path: clientReq.url || '/',
    method: clientReq.method || 'GET',
    handler: 'handleApiHost',
    upstreamStatus: null,
  };
  proxyEvents.push(event);
  log(`  [proxy] API: ${clientReq.method} ${targetHost}${clientReq.url}`);

  try {
    await proxyBuffered(
      clientReq, clientRes, targetHost, targetPort,
      (headers) => {
        stripEncoding(headers);
        log(`  [proxy] API request headers: ${JSON.stringify(Object.keys(headers))}`);
      },
      (body) => {
        logBody('API request', body);
        return body;
      },
      (body, status) => {
        event.upstreamStatus = status;
        log(`  [proxy] API response: ${status}`);
        logBody('API response', body);
        return body;
      },
    );
  } catch (err) {
    log(`  [proxy] API error: ${err}`);
  }
};

const instrumentedTokenExchangeHandler: HostHandler = async (
  clientReq, clientRes, targetHost, targetPort, scope,
) => {
  const event: ProxyEvent = {
    timestamp: Date.now(),
    hostname: targetHost,
    path: clientReq.url || '/',
    method: clientReq.method || 'POST',
    handler: 'handleOAuthTokenExchange',
    upstreamStatus: null,
  };
  proxyEvents.push(event);
  log(`  [proxy] TOKEN EXCHANGE: ${clientReq.method} ${targetHost}${clientReq.url}`);
  log(`  [proxy] TOKEN EXCHANGE request headers: ${JSON.stringify(clientReq.headers)}`);

  try {
    await proxyBuffered(
      clientReq, clientRes, targetHost, targetPort,
      (headers) => {
        stripEncoding(headers);
        log(`  [proxy] TOKEN EXCHANGE outbound headers: ${JSON.stringify(Object.keys(headers))}`);
      },
      (body) => {
        logBody('Token exchange request', body);
        return body;
      },
      (body, status) => {
        event.upstreamStatus = status;
        log(`  [proxy] Token exchange response: ${status}`);
        logBody('Token exchange response', body);
        return body;
      },
    );
  } catch (err) {
    log(`  [proxy] Token exchange error: ${err}`);
  }
};

// Catch-all handler — logs full request and response bodies via proxyBuffered
const instrumentedCatchAllHandler: HostHandler = async (
  clientReq, clientRes, targetHost, targetPort, scope,
) => {
  const event: ProxyEvent = {
    timestamp: Date.now(),
    hostname: targetHost,
    path: clientReq.url || '/',
    method: clientReq.method || 'GET',
    handler: 'handleCatchAll',
    upstreamStatus: null,
  };
  proxyEvents.push(event);
  log(`  [proxy] CATCH-ALL: ${clientReq.method} ${targetHost}${clientReq.url}`);

  try {
    await proxyBuffered(
      clientReq, clientRes, targetHost, targetPort,
      (headers) => {
        stripEncoding(headers);
        log(`  [proxy] CATCH-ALL request headers: ${JSON.stringify(Object.keys(headers))}`);
      },
      (body) => {
        logBody(`CATCH-ALL request ${targetHost}${clientReq.url}`, body);
        return body;
      },
      (body, status) => {
        event.upstreamStatus = status;
        log(`  [proxy] CATCH-ALL response: ${status}`);
        logBody(`CATCH-ALL response ${targetHost}${clientReq.url}`, body);
        return body;
      },
    );
  } catch (err) {
    log(`  [proxy] CATCH-ALL error: ${err}`);
  }
};

// ── Container setup ──────────────────────────────────────────────────

const PROXY_PORT = 13001;

function detectProxyBind(): string {
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find(a => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  try {
    const out = execSync('ip addr show docker0', { encoding: 'utf-8', timeout: 3000 });
    const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  throw new Error('docker0 interface not found');
}

function getContainerIP(containerName: string): Promise<string | null> {
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
      if (attempt < 15) setTimeout(tryInspect, 500);
      else resolve(null);
    };
    setTimeout(tryInspect, 500);
  });
}

// ── Main ─────────────────────────────────────────────────────────────

const OAUTH_URL_FILE = '/tmp/oauth-url.txt';
const CALLBACK_URL_FILE = '/tmp/callback-url.txt';
const AUTH_IPC_DIR = '/tmp/nanoclaw-auth-ipc';
const CREDS_OUTPUT_DIR = '/tmp/nanoclaw-auth-creds';

async function main(): Promise<void> {
  // Clean up from previous runs
  try { fs.unlinkSync(OAUTH_URL_FILE); } catch {}
  try { fs.unlinkSync(CALLBACK_URL_FILE); } catch {}
  fs.mkdirSync(AUTH_IPC_DIR, { recursive: true });
  fs.chmodSync(AUTH_IPC_DIR, 0o777);
  fs.mkdirSync(CREDS_OUTPUT_DIR, { recursive: true });
  fs.chmodSync(CREDS_OUTPUT_DIR, 0o777);

  const PROXY_BIND = detectProxyBind();
  log(`Proxy bind: ${PROXY_BIND}:${PROXY_PORT}`);

  // Catch-all: intercept EVERY host so nothing passes through unlogged.
  // More specific rules first, then wildcard.
  registerProviderHost(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, instrumentedTokenExchangeHandler);
  registerProviderHost(/^console\.anthropic\.com$/, /^\//, instrumentedCatchAllHandler);
  registerProviderHost(/^api\.anthropic\.com$/, /^\//, instrumentedApiHandler);
  registerProviderHost(/.*/, /^\//, instrumentedCatchAllHandler); // catch-all for any other host
  setCredentialResolver(() => ({}));

  const server = await startCredentialProxy({
    port: PROXY_PORT,
    host: PROXY_BIND,
    enableTransparent: true,
  });
  log('Proxy started');

  // xdg-open shim path
  const xdgShim = path.join(process.cwd(), 'container', 'shims', 'xdg-open');
  const caCertPath = getMitmCaCertPath();
  const containerName = `nanoclaw-auth-test-${Date.now()}`;

  const args: string[] = [
    'run', '-i', '--rm',
    '--name', containerName,
    '--cap-add=NET_ADMIN',
    '-e', `PROXY_HOST=${CONTAINER_HOST_GATEWAY}`,
    '-e', `PROXY_PORT=${PROXY_PORT}`,
    '-e', 'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/nanoclaw-mitm.crt',
    '-v', `${caCertPath}:/usr/local/share/ca-certificates/nanoclaw-mitm.crt:ro`,
    '-v', `${AUTH_IPC_DIR}:/workspace/auth-ipc`,
    '-v', `${xdgShim}:/usr/local/bin/xdg-open:ro`,
    '-v', `${xdgShim}:/usr/bin/xdg-open:ro`,
    // Mount host dir to capture .credentials.json after auth completes
    '-v', `${CREDS_OUTPUT_DIR}:/root/.claude`,
    ...hostGatewayArgs(),
    '--entrypoint', '',
    CONTAINER_IMAGE,
    '/bin/bash', '-c',
    `PROXY_IP=$(getent hosts $PROXY_HOST | awk "{print \\$1}" || echo $PROXY_HOST) && ` +
    `iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination $PROXY_IP:$PROXY_PORT && ` +
    `update-ca-certificates 2>/dev/null && ` +
    `claude auth login 2>&1`,
  ];

  log(`Starting auth container: ${containerName}`);
  const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.end();

  const containerIP = await getContainerIP(containerName);
  if (containerIP) {
    registerContainerIP(containerIP, 'default');
    log(`Registered container IP: ${containerIP}`);
  } else {
    log('WARNING: Could not get container IP');
  }

  let stdout = '';
  proc.stdout.on('data', (d) => {
    const chunk = d.toString();
    stdout += chunk;
    // Print raw stdout for debugging
    for (const line of chunk.split('\n')) {
      if (line.trim()) log(`  cli: ${line}`);
    }
  });
  proc.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) log(`  cli-err: ${line}`);
    }
  });

  // Watch for OAuth URL in stdout or auth-ipc file
  log('Waiting for OAuth URL...');
  const oauthUrl = await new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 60_000);

    const check = setInterval(() => {
      // Check stdout for OAuth URL
      const urlMatch = stdout.match(/https:\/\/(console\.anthropic\.com|claude\.ai)\S+/);
      if (urlMatch) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve(urlMatch[0]);
        return;
      }
      // Check auth-ipc file written by xdg-open shim
      try {
        const shimUrl = fs.readFileSync(path.join(AUTH_IPC_DIR, '.oauth-url'), 'utf-8').trim();
        if (shimUrl) {
          clearInterval(check);
          clearTimeout(timeout);
          // The shim captures the localhost callback URL, not the OAuth URL
          // Extract the actual OAuth URL from stdout
          log(`  xdg-open shim captured: ${shimUrl}`);
          // Keep looking for the OAuth URL in stdout
        }
      } catch {}
    }, 500);
  });

  if (!oauthUrl) {
    log('FAIL: No OAuth URL found in 60s');
    log(`Last stdout: ${stdout.slice(-500)}`);
    proc.kill();
    server.close();
    process.exit(1);
  }

  log(`\n${'═'.repeat(60)}`);
  log(`  OAuth URL found!`);
  log(`  ${oauthUrl}`);
  log(`${'═'.repeat(60)}`);
  fs.writeFileSync(OAUTH_URL_FILE, oauthUrl);
  log(`Written to ${OAUTH_URL_FILE}`);

  // Also check for the shim-captured localhost callback URL
  let callbackPort: number | null = null;
  try {
    const shimUrl = fs.readFileSync(path.join(AUTH_IPC_DIR, '.oauth-url'), 'utf-8').trim();
    const portMatch = shimUrl.match(/localhost%3A(\d+)/) || shimUrl.match(/localhost:(\d+)/);
    if (portMatch) {
      callbackPort = parseInt(portMatch[1], 10);
      log(`CLI callback server on container port: ${callbackPort}`);
    }
    log(`Full shim URL: ${shimUrl}`);
  } catch {}

  // Now wait for the container to exit.
  // The user will deliver the callback externally via:
  //   docker exec <container> curl 'http://localhost:PORT/callback?code=...&state=...'
  log(`\nWaiting for container to exit (deliver callback via docker exec)...`);
  log(`Container: ${containerName}`);
  if (callbackPort) log(`Callback port: ${callbackPort}`);

  const exitCode = await new Promise<number>((resolve) => {
    const timeout = setTimeout(() => {
      log('Container timeout (5 min), killing');
      try { execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${containerName}`, { stdio: 'pipe' }); } catch {}
      resolve(1);
    }, 300_000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });

  log(`\nCLI exit code: ${exitCode}`);
  log(`\n${'═'.repeat(60)}`);
  log(`  PROXY EVENT SUMMARY`);
  log(`${'═'.repeat(60)}`);
  for (const ev of proxyEvents) {
    log(`  ${ev.handler}: ${ev.method} ${ev.hostname}${ev.path} → ${ev.upstreamStatus}`);
  }

  const tokenEvents = proxyEvents.filter(e => e.handler === 'handleOAuthTokenExchange');
  log(`\nToken exchange events: ${tokenEvents.length}`);
  if (tokenEvents.length > 0) {
    log('✓ SUCCESS: Token exchange intercepted by proxy!');
  } else {
    log('✗ No token exchange events (may use different host/path)');
  }

  // Dump saved .credentials.json
  const credsFile = path.join(CREDS_OUTPUT_DIR, '.credentials.json');
  try {
    const creds = fs.readFileSync(credsFile, 'utf-8');
    log(`\n${'═'.repeat(60)}`);
    log(`  SAVED .credentials.json`);
    log(`${'═'.repeat(60)}`);
    // Redact token values but show structure and key prefixes
    const parsed = JSON.parse(creds);
    const redacted = JSON.parse(JSON.stringify(parsed), (key, val) => {
      if (typeof val === 'string' && val.length > 40 && key !== 'expiresAt') {
        return val.slice(0, 30) + '...[REDACTED len=' + val.length + ']';
      }
      return val;
    });
    log(JSON.stringify(redacted, null, 2));
  } catch {
    log(`\nNo .credentials.json found at ${credsFile}`);
  }

  if (containerIP) unregisterContainerIP(containerIP);
  server.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
