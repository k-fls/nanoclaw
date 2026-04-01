/**
 * Credential proxy Docker arguments — extracted from container-runner.ts
 * and container-runtime.ts to reduce footprint in core files.
 *
 * applyCredentialProxyArgs() injects all proxy-related Docker args
 * (MITM certs, iptables env vars, substitute tokens, user mapping)
 * and returns a cleanup function for IP deregistration.
 */
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';

import { CREDENTIAL_PROXY_PORT } from '../config.js';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { getProxy, type CredentialProxy } from '../credential-proxy.js';
import { getMitmCaCertPath } from '../mitm-proxy.js';
import { getAllProviders } from './registry.js';
import type { TokenSubstituteEngine } from './token-substitute.js';
import type { GroupScope } from './oauth-types.js';
import type { RegisteredGroup } from '../types.js';
import { scopeOf } from '../types.js';
import { logger } from '../logger.js';

// ── Host constants ─────────────────────────────────────────────────

/** Hostname containers use to reach the host machine. */
const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Must match what Docker's `host-gateway` resolves to, since containers use
 * iptables DNAT to redirect :443 → host-gateway:PROXY_PORT.
 *
 * Docker Desktop (macOS/WSL): 127.0.0.1 — the VM routes host-gateway to loopback.
 * Docker Engine (Linux): docker0 bridge IP — host-gateway resolves to this
 *   regardless of which Docker network the container is on.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP (what host-gateway resolves to).
  // os.networkInterfaces() omits interfaces in DOWN state (docker0 when no
  // containers are running), so fall back to parsing `ip addr` directly.
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
  } catch {
    /* docker0 not found */
  }

  return '127.0.0.1';
}

// ── Substitute credential injection ────────────────────────────────

/**
 * Provision substitute credentials from all providers and inject as env vars.
 * The token engine resolves credential source scopes internally per-provider
 * using the group's flags (useDefaultCredentials, isMain).
 * Providers handle writing any provider-specific files (e.g. .credentials.json).
 */
function injectSubstituteCredentials(
  args: string[],
  group: RegisteredGroup,
  tokenEngine: TokenSubstituteEngine,
): void {
  for (const provider of getAllProviders()) {
    const { env } = provider.provision(group, tokenEngine);
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }
  }
}

// ── Shared proxy plumbing ──────────────────────────────────────────

/**
 * Apply transparent proxy Docker args: iptables env vars, MITM CA cert,
 * NET_ADMIN capability, and user mapping for privilege drop.
 *
 * Shared between agent containers (container-runner.ts) and auth containers
 * (exec.ts). Does NOT inject substitute credentials — callers add those
 * separately when needed.
 */
export function applyTransparentProxyArgs(args: string[]): void {
  // NET_ADMIN for iptables in entrypoint (dropped by setpriv before app runs).
  // no-new-privileges prevents re-escalation via setuid binaries after privilege drop.
  args.push('--cap-add=NET_ADMIN');
  args.push('--security-opt=no-new-privileges');
  args.push('-e', `PROXY_HOST=${CONTAINER_HOST_GATEWAY}`);
  args.push('-e', `PROXY_PORT=${CREDENTIAL_PROXY_PORT}`);

  // Mount MITM CA cert so system CA store trusts our forged certs
  const caCertPath = getMitmCaCertPath();
  args.push(
    '-v',
    `${caCertPath}:/usr/local/share/ca-certificates/nanoclaw-mitm.crt:ro`,
  );
  // Also set NODE_EXTRA_CA_CERTS for Node.js apps that don't use system store
  args.push(
    '-e',
    'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/nanoclaw-mitm.crt',
  );

  // Transparent proxy: entrypoint starts as root for iptables, then drops
  // privileges via setpriv. Pass host uid/gid so it drops to the right user.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('-e', `HOST_UID=${hostUid}`);
    args.push('-e', `HOST_GID=${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Apply all credential-proxy-related Docker args to a container args array.
 * Transparent proxy plumbing + substitute token injection.
 */
export function applyCredentialProxyArgs(
  args: string[],
  group: RegisteredGroup,
  tokenEngine: TokenSubstituteEngine,
): void {
  applyTransparentProxyArgs(args);

  // Generate format-preserving substitute tokens for the container.
  // Real credentials stay on the host; containers only see substitutes.
  injectSubstituteCredentials(args, group, tokenEngine);
}

// ── Dedicated Docker network for static container IPs ─────────────────
const NANOCLAW_NETWORK = 'nanoclaw';

/** Configurable /16 subnet for the nanoclaw bridge network (must end in .0.0/16). */
function parseSubnet(value: string): { subnet: string; prefix: string } {
  if (!/^\d+\.\d+\.0\.0\/16$/.test(value)) {
    throw new Error(`Invalid NANOCLAW_SUBNET "${value}" — must be X.Y.0.0/16`);
  }
  return { subnet: value, prefix: value.split('.').slice(0, 2).join('.') };
}

const { subnet: NANOCLAW_SUBNET, prefix: NANOCLAW_SUBNET_PREFIX } = parseSubnet(
  process.env.NANOCLAW_SUBNET || '172.29.0.0/16',
);

/** Monotonic counter for IP allocation. Starts at 2 (skip .0.0 network, .0.1 gateway). */
let nextHostPart = 2;

/** Ensure the dedicated nanoclaw bridge network exists. Idempotent. */
export function ensureNetwork(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${NANOCLAW_NETWORK}`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    logger.debug('nanoclaw network already exists');
    return;
  } catch {
    /* network doesn't exist yet — create it */
  }

  try {
    execSync(
      `${CONTAINER_RUNTIME_BIN} network create ` +
        `--subnet ${NANOCLAW_SUBNET} ` +
        `-o com.docker.network.bridge.enable_icc=false ` +
        NANOCLAW_NETWORK,
      { stdio: 'pipe', timeout: 10000 },
    );
    logger.info({ subnet: NANOCLAW_SUBNET }, 'Created nanoclaw network');
  } catch {
    // Concurrent creation race — verify the network exists now
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${NANOCLAW_NETWORK}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      throw new Error('Failed to create nanoclaw Docker network');
    }
  }
}

export interface AllocatedIP {
  ip: string;
  /** Deregister the IP from the proxy — call on container exit. */
  release: () => void;
}

/**
 * Allocate a static container IP and register it in the proxy's IP→scope map.
 * Both operations are synchronous — no race between check and register in
 * the Node.js event loop.
 *
 * Returns the IP and a release closure for cleanup.
 */
export function allocateContainerIP(
  scope: GroupScope,
  proxy: CredentialProxy = getProxy(),
): AllocatedIP {
  const start = nextHostPart;
  do {
    const hi = (nextHostPart >> 8) & 0xff;
    const lo = nextHostPart & 0xff;
    const ip = `${NANOCLAW_SUBNET_PREFIX}.${hi}.${lo}`;
    nextHostPart = nextHostPart >= 65534 ? 2 : nextHostPart + 1;
    if (!proxy.hasContainerIP(ip)) {
      proxy.registerContainerIP(ip, scope);
      return { ip, release: () => proxy.unregisterContainerIP(ip) };
    }
  } while (nextHostPart !== start);
  throw new Error('IP pool exhausted');
}

/** CLI args to place a container on the nanoclaw network with a static IP. */
export function networkArgs(ip: string): string[] {
  return ['--network', NANOCLAW_NETWORK, '--ip', ip];
}
