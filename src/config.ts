import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
); // 30min
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — no output for this long = stuck container
export const GRACE_TIMEOUT = parseInt(process.env.GRACE_TIMEOUT || '30000', 10); // 30s — time for container to exit after soft stop before hard kill
export const EVICTION_TIMEOUT = parseInt(
  process.env.EVICTION_TIMEOUT || '14400000',
  10,
); // 4h — how long an evictable container can sit before auto-stop
export const IDLE_BEFORE_EVICT = parseInt(
  process.env.IDLE_BEFORE_EVICT || '600000',
  10,
); // 10min — protection period after idle before becoming evictable
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

/** Strip the leading "@" from a trigger to get the bot name (e.g. "@Claw" → "Claw"). */
export function triggerToName(trigger: string): string {
  return trigger.replace(/^@/, '').trim() || ASSISTANT_NAME;
}

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// ── Claude CLI update ──────────────────────────────────────────────
// CLAUDE_CLI_UPDATE controls container-side CLI updates:
//   unset / empty  → no updates, use image-baked version
//   duration (24h) → check for latest at startup, repeat at interval
//   semver (2.1.92)→ pin to that version, install once at startup

export const CLAUDE_CLI_UPDATE = process.env.CLAUDE_CLI_UPDATE?.trim() || '';
export const CLAUDE_CLI_DIR = path.join(DATA_DIR, 'claude-cli');

/** Parse CLAUDE_CLI_UPDATE into a typed config. */
export function parseClaudeCliUpdate(raw: string): {
  mode: 'off' | 'latest' | 'pinned';
  intervalMs: number;
  version: string;
} {
  if (!raw) return { mode: 'off', intervalMs: 0, version: '' };

  // Duration: digits followed by h/d/m
  const durationMatch = raw.match(/^(\d+)\s*(h|d|m)$/i);
  if (durationMatch) {
    const n = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const multiplier = unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 60000;
    return { mode: 'latest', intervalMs: n * multiplier, version: '' };
  }

  // Semver-like: digits and dots
  if (/^\d+\.\d+(\.\d+)?$/.test(raw)) {
    return { mode: 'pinned', intervalMs: 0, version: raw };
  }

  // Unrecognized — treat as off
  return { mode: 'off', intervalMs: 0, version: '' };
}
