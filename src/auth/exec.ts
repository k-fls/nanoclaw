/**
 * ExecHandle implementation — wraps container-runtime.ts to spawn commands
 * inside the agent container for auth flows.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from '../config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from '../container-runtime.js';
import { getSnapshotDir } from '../container-runner.js';
import { getProxy } from '../credential-proxy.js';
import {
  allocateContainerIP,
  applyTransparentProxyArgs,
  networkArgs,
} from './container-args.js';
import { asGroupScope } from './oauth-types.js';
import type { CredentialScope } from './oauth-types.js';
import { logger } from '../logger.js';
import type { ExecContainerResult, ExecHandle } from './types.js';

export interface ExecContainerOpts {
  /** Provider-specific bind mounts as [hostPath, containerPath, mode?] tuples. */
  mounts?: Array<[string, string, string?]>;
  /** Override the default hard timeout (IDLE_TIMEOUT). */
  timeoutMs?: number;
  /**
   * Credential scope registered in the proxy's IP→scope map so intercepted
   * tokens land in the correct credential store.
   */
  credentialScope: CredentialScope;
}

// Resolve paths from the snapshot dir (frozen at startup) so a project
// update while running doesn't break auth containers mid-flight.
const shimPath = (name: string) => path.join(getSnapshotDir(), 'shims', name);
const XDG_OPEN_SHIM = () => shimPath('xdg-open-auth');
const AUTH_EXEC_SHIM = () => shimPath('auth-exec.ts');
const ENTRYPOINT_PATH = () => path.join(getSnapshotDir(), 'entrypoint.sh');
const AGENT_RUNNER_TSCONFIG = () =>
  path.join(getSnapshotDir(), 'agent-runner', 'tsconfig.json');

/**
 * Spawn a command inside a nanoclaw-agent container with transparent proxy.
 *
 * The container is placed on the nanoclaw bridge network with iptables-based
 * MITM so the credential proxy intercepts all HTTPS traffic (including token
 * exchanges, capturing authFields). The command runs via the auth-exec shim
 * mounted over `/app/src/index.ts` — the standard entrypoint handles
 * iptables + CA install + privilege drop before the shim spawns the command.
 *
 * Infrastructure mounts (always added):
 *   - xdg-open shim at /usr/local/bin and /usr/bin (captures OAuth URLs)
 *   - auth-ipc dir at /workspace/auth-ipc (auth shim writes .oauth-url here)
 *   - auth-exec shim at /app/src/index.ts (compiled + run by entrypoint)
 *   - entrypoint.sh + tsconfig.json (shared with agent containers)
 *   - MITM CA cert
 *
 * Provider-specific mounts come through opts.mounts.
 */
export function startExecInContainer(
  command: string[],
  sessionDir: string,
  opts: ExecContainerOpts,
): ExecContainerResult {
  const authIpcDir = path.join(sessionDir, 'auth-ipc');
  fs.mkdirSync(authIpcDir, { recursive: true });
  // Explicit chmod because mkdirSync's mode is masked by umask
  fs.chmodSync(authIpcDir, 0o777);

  const containerName = `nanoclaw-auth-${Date.now()}`;
  const { ip: containerIP, release: releaseIP } = allocateContainerIP(
    asGroupScope(opts.credentialScope),
    getProxy(),
  );

  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    '-e',
    `TZ=${TIMEZONE}`,
  ];

  // Bridge network with static IP (same as agent containers)
  args.push(...networkArgs(containerIP));
  args.push(...hostGatewayArgs());

  // Transparent proxy: iptables, MITM CA, NET_ADMIN, user mapping
  applyTransparentProxyArgs(args);

  // Pass the real command via env var — the auth-exec shim reads it
  args.push('-e', `AUTH_EXEC_CMD=${JSON.stringify(command)}`);

  // Mount from snapshot (frozen at startup by snapshotContainerFiles).
  args.push(...readonlyMountArgs(AUTH_EXEC_SHIM(), '/app/src/index.ts'));

  const entrypoint = ENTRYPOINT_PATH();
  if (fs.existsSync(entrypoint)) {
    args.push(...readonlyMountArgs(entrypoint, '/app/entrypoint.sh'));
  }
  const tsconfig = AGENT_RUNNER_TSCONFIG();
  if (fs.existsSync(tsconfig)) {
    args.push(...readonlyMountArgs(tsconfig, '/app/tsconfig.json'));
  }

  // Infrastructure mounts
  args.push('-v', `${authIpcDir}:/workspace/auth-ipc`);
  const xdgOpen = XDG_OPEN_SHIM();
  if (fs.existsSync(xdgOpen)) {
    args.push(...readonlyMountArgs(xdgOpen, '/usr/local/bin/xdg-open'));
    args.push(...readonlyMountArgs(xdgOpen, '/usr/bin/xdg-open'));
  }

  // Provider-specific mounts
  for (const [hostPath, containerPath, mode] of opts.mounts ?? []) {
    if (fs.existsSync(hostPath)) {
      args.push(
        '-v',
        mode
          ? `${hostPath}:${containerPath}:${mode}`
          : `${hostPath}:${containerPath}`,
      );
    }
  }

  args.push(CONTAINER_IMAGE);
  // Entrypoint runs with no CMD args — compiles + runs auth-exec shim
  // which reads AUTH_EXEC_CMD and spawns the real command.

  logger.debug(
    { containerName, command, sessionDir, containerIP },
    'Spawning auth container',
  );

  const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const stdoutCallbacks: Array<(chunk: string) => void> = [];

  proc.stdout.on('data', (data) => {
    const chunk = data.toString();
    stdout += chunk;
    for (const cb of stdoutCallbacks) cb(chunk);
  });

  proc.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  const effectiveTimeout = opts.timeoutMs ?? IDLE_TIMEOUT;
  const killTimer = setTimeout(() => {
    logger.warn(
      { containerName, timeoutMs: effectiveTimeout },
      'Auth container timeout, stopping gracefully',
    );
    try {
      stopContainer(containerName);
    } catch (err) {
      logger.warn(
        { containerName, err },
        'Graceful stop failed, force killing',
      );
      proc.kill('SIGKILL');
    }
  }, effectiveTimeout);

  proc.on('close', () => {
    clearTimeout(killTimer);
    releaseIP();
  });

  // Cache the wait promise so multiple calls don't hang
  let waitPromise: Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> | null = null;

  const handle: ExecHandle = {
    onStdout(cb: (chunk: string) => void): void {
      stdoutCallbacks.push(cb);
    },
    stdin: {
      write(data: string): void {
        proc.stdin.write(data);
      },
      end(): void {
        proc.stdin.end();
      },
    },
    wait(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      if (!waitPromise) {
        waitPromise = new Promise((resolve) => {
          proc.on('close', (code) => {
            resolve({ exitCode: code ?? 1, stdout, stderr });
          });
          proc.on('error', (err) => {
            logger.error({ containerName, err }, 'Auth container spawn error');
            resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
          });
        });
      }
      return waitPromise;
    },
    kill(): void {
      try {
        stopContainer(containerName);
      } catch {
        proc.kill('SIGKILL');
      }
    },
  };

  return { handle, containerIP };
}

/** Base data directory for a scope (e.g. data/sessions/{scope}). */
export function scopeDataDir(scope: string, ...subpath: string[]): string {
  return path.join(DATA_DIR, 'sessions', scope, ...subpath);
}

/** Claude CLI data directory for a scope (e.g. data/sessions/{scope}/.claude). */
export function scopeClaudeDir(scope: string, ...subpath: string[]): string {
  return scopeDataDir(scope, '.claude', ...subpath);
}

/** Resolve the auth session directory for a scope. */
export function authSessionDir(scope: string): string {
  return scopeDataDir(scope, '.claude-auth');
}

/**
 * Shared stub .claude.json — the CLI expects this at /home/node/.claude.json
 * and loops if missing. A single empty object is sufficient.
 * Created once on first access, reused across all scopes (read-only mount).
 */
export const CLAUDE_CONFIG_STUB = path.join(DATA_DIR, '.claude.json');

/** Ensure the stub file exists. Call once at startup or lazily. */
export function ensureClaudeConfigStub(): void {
  if (!fs.existsSync(CLAUDE_CONFIG_STUB)) {
    fs.mkdirSync(path.dirname(CLAUDE_CONFIG_STUB), { recursive: true });
    fs.writeFileSync(CLAUDE_CONFIG_STUB, '{}', 'utf-8');
  }
}
