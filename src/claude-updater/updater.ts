/**
 * Claude CLI updater — keeps the container-side Claude CLI binary current
 * without rebuilding the container image.
 *
 * Uses a temp container from the same image to run npm install into a
 * host-mounted directory. Agent containers then mount that directory
 * read-only and use pathToClaudeCodeExecutable to point to it.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CLAUDE_CLI_DIR,
  CLAUDE_CLI_UPDATE,
  CONTAINER_IMAGE,
  parseClaudeCliUpdate,
} from '../config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from '../container-runtime.js';
import { logger } from '../logger.js';
import { AsyncRWLock } from './async-rw-lock.js';

/** Singleton lock: shared for container spawns, exclusive for updates. */
export const cliLock = new AsyncRWLock();

const CLI_PACKAGE = '@anthropic-ai/claude-code';

/** Runtime setting — initialized from env, can be changed via reconfigure(). */
let activeSetting = CLAUDE_CLI_UPDATE;

/** Path to cli.js inside the mounted directory, or null if not available. */
export function getClaudeCliPath(): string | null {
  const cliJs = path.join(
    CLAUDE_CLI_DIR,
    'node_modules',
    CLI_PACKAGE,
    'cli.js',
  );
  return fs.existsSync(cliJs) ? cliJs : null;
}

/** Read installed version from package.json, or null if not installed. */
export function installedVersion(): string | null {
  const pkgJson = path.join(
    CLAUDE_CLI_DIR,
    'node_modules',
    CLI_PACKAGE,
    'package.json',
  );
  if (!fs.existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Query npm registry for latest version. Returns null on failure. */
function latestVersion(): string | null {
  try {
    return execSync(`npm view ${CLI_PACKAGE} version`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
  } catch (err) {
    logger.warn({ err }, 'Failed to query latest Claude CLI version');
    return null;
  }
}

/** Run npm install inside a temp container with the target dir mounted. */
function runInstallContainer(targetDir: string, packageSpec: string): boolean {
  fs.mkdirSync(targetDir, { recursive: true });

  const args = [
    'run',
    '--rm',
    '-v',
    `${targetDir}:/mount`,
    ...hostGatewayArgs(),
    '--entrypoint',
    'npm',
    CONTAINER_IMAGE,
    'install',
    '--prefix',
    '/mount',
    packageSpec,
  ];

  try {
    logger.info({ packageSpec }, 'Running Claude CLI update container');
    execFileSync(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 min
    });
    return true;
  } catch (err) {
    logger.error({ err, packageSpec }, 'Claude CLI update container failed');
    return false;
  }
}

/**
 * Run the update flow based on the active setting.
 * Returns true if containers should use the updated CLI.
 */
export async function runUpdate(): Promise<boolean> {
  const config = parseClaudeCliUpdate(activeSetting);
  if (config.mode === 'off') return getClaudeCliPath() !== null;

  const current = installedVersion();

  if (config.mode === 'pinned') {
    if (current === config.version) {
      logger.info({ version: current }, 'Claude CLI already at pinned version');
      return true;
    }

    // Pinned: exclusive lock before install (deterministic target)
    await cliLock.acquireExclusive();
    try {
      const ok = runInstallContainer(
        CLAUDE_CLI_DIR,
        `${CLI_PACKAGE}@${config.version}`,
      );
      if (ok) {
        logger.info(
          { version: config.version },
          'Claude CLI pinned version installed',
        );
      }
      return ok;
    } finally {
      cliLock.releaseExclusive();
    }
  }

  // mode === 'latest'
  const latest = latestVersion();
  if (!latest) {
    logger.warn(
      'Could not determine latest Claude CLI version, skipping update',
    );
    return current !== null;
  }
  if (current === latest) {
    logger.info({ version: current }, 'Claude CLI already at latest');
    return true;
  }

  // Latest: install into staging dir (no lock), then swap (exclusive lock)
  const stagingDir = `${CLAUDE_CLI_DIR}-staging`;
  const ok = runInstallContainer(stagingDir, `${CLI_PACKAGE}@${latest}`);
  if (!ok) return current !== null;

  await cliLock.acquireExclusive();
  try {
    if (fs.existsSync(CLAUDE_CLI_DIR)) {
      fs.rmSync(CLAUDE_CLI_DIR, { recursive: true });
    }
    fs.renameSync(stagingDir, CLAUDE_CLI_DIR);
    logger.info({ from: current, to: latest }, 'Claude CLI updated');
  } finally {
    cliLock.releaseExclusive();
  }
  return true;
}

// ── Update manager ─────────────────────────────────────────────────

let periodicTimer: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

function startTimer(intervalMs: number): void {
  stopTimer();
  periodicTimer = setInterval(() => {
    runUpdate().catch((err) => {
      logger.error({ err }, 'Periodic Claude CLI update failed');
    });
  }, intervalMs);
  periodicTimer.unref();
  logger.info({ intervalMs }, 'Claude CLI periodic updates scheduled');
}

/**
 * Start the update manager. Runs initial update, then schedules
 * periodic updates if configured as a duration. Call once at startup.
 */
export async function startUpdateManager(): Promise<void> {
  const config = parseClaudeCliUpdate(activeSetting);
  if (config.mode === 'off') return;

  await runUpdate();

  if (config.mode === 'latest' && config.intervalMs > 0) {
    startTimer(config.intervalMs);
  }
}

/** Stop the update manager. Call on shutdown. */
export function stopUpdateManager(): void {
  stopTimer();
}

/** Current active setting string. */
export function getActiveSetting(): string {
  return activeSetting;
}

/**
 * Change the update setting at runtime. Stops any existing timer
 * and starts a new one if the new setting is a duration.
 */
export function reconfigure(newSetting: string): void {
  activeSetting = newSetting;
  stopTimer();
  const config = parseClaudeCliUpdate(newSetting);
  if (config.mode === 'latest' && config.intervalMs > 0) {
    startTimer(config.intervalMs);
  }
}
