import {
  DEFAULT_TRIGGER,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
} from '../config.js';
import { isValidTimezone } from '../timezone.js';
import {
  ContainerConfig,
  RegisteredGroup,
  SETTINGS,
  SettingKey,
} from '../types.js';

// --- Resolvers (compile-time enforced: every SettingKey must have one) ---

const RESOLVERS: {
  [K in SettingKey]: (
    config: ContainerConfig | undefined,
    group?: RegisteredGroup,
  ) => unknown;
} = {
  timezone: (c) => c?.timezone ?? TIMEZONE,
  trigger: (c, g) => c?.trigger ?? g?.trigger ?? DEFAULT_TRIGGER,
  requiresTrigger: (c, g) => c?.requiresTrigger ?? g?.requiresTrigger ?? true,
  triggerUsers: (c) => c?.triggerUsers ?? null,
  timeout: (c) => c?.timeout ?? IDLE_TIMEOUT,
  maxMessages: (c) => c?.maxMessages ?? MAX_MESSAGES_PER_PROMPT,
};

/** Resolve a setting's effective value through the chain: config → legacy → default. */
export function resolve(
  key: SettingKey,
  config?: ContainerConfig,
  group?: RegisteredGroup,
): unknown {
  return RESOLVERS[key](config, group);
}

// --- Typed convenience getters ---

export function getGroupTimezone(config?: ContainerConfig): string {
  return RESOLVERS.timezone(config) as string;
}

export function getGroupTrigger(
  config?: ContainerConfig,
  group?: RegisteredGroup,
): string {
  return RESOLVERS.trigger(config, group) as string;
}

export function getGroupRequiresTrigger(
  config?: ContainerConfig,
  group?: RegisteredGroup,
): boolean {
  return RESOLVERS.requiresTrigger(config, group) as boolean;
}

export function getGroupTriggerUsers(
  config?: ContainerConfig,
): string[] | null {
  return RESOLVERS.triggerUsers(config) as string[] | null;
}

export function getGroupTimeout(config?: ContainerConfig): number {
  return RESOLVERS.timeout(config) as number;
}

export function getGroupMaxMessages(config?: ContainerConfig): number {
  return RESOLVERS.maxMessages(config) as number;
}

// --- Appliers (compile-time enforced: every SettingKey must have one) ---
// Each validates the incoming value, mutates the config, and returns an error string on failure.

const APPLIERS: {
  [K in SettingKey]: (config: ContainerConfig, value: unknown) => string | null;
} = {
  timezone: (c, v) => {
    if (typeof v !== 'string' || !isValidTimezone(v))
      return 'Invalid IANA timezone';
    c.timezone = v;
    return null;
  },
  trigger: (c, v) => {
    if (typeof v !== 'string' || !v.trim())
      return 'Trigger must be a non-empty string';
    if (v.length > 50) return 'Trigger must be 50 characters or fewer';
    c.trigger = v;
    return null;
  },
  requiresTrigger: (c, v) => {
    if (typeof v !== 'boolean') return 'Must be a boolean';
    c.requiresTrigger = v;
    return null;
  },
  triggerUsers: (c, v) => {
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string'))
      return 'Must be an array of strings';
    c.triggerUsers = v;
    return null;
  },
  timeout: (c, v) => {
    if (typeof v !== 'number') return 'Must be a number';
    if (v < 30000 || v > 7200000)
      return 'Must be between 30000 (30s) and 7200000 (2h)';
    c.timeout = v;
    return null;
  },
  maxMessages: (c, v) => {
    if (typeof v !== 'number') return 'Must be a number';
    if (v < 1 || v > 100) return 'Must be between 1 and 100';
    c.maxMessages = v;
    return null;
  },
};

/** Validate and apply a setting value to a ContainerConfig. Returns error string or null. */
export function applySetting(
  config: ContainerConfig,
  key: SettingKey,
  value: unknown,
): string | null {
  return APPLIERS[key](config, value);
}

/** Check whether a key is a valid setting key. */
export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS;
}

// --- Settings snapshot for container consumption ---

export interface SettingSnapshot {
  key: SettingKey;
  value: unknown;
  description: string;
  /** Whether the caller can change this setting (main can always, non-main only if enabled). */
  modifiable: boolean;
  /** Whether the group itself is allowed to self-modify this setting (reflects updateable_settings). */
  group_modifiable: boolean;
}

/** Build the full settings snapshot written to current_settings.json before container launch. */
export function buildSettingsSnapshot(
  config: ContainerConfig | undefined,
  group: RegisteredGroup,
  isMain: boolean,
): SettingSnapshot[] {
  const enabledKeys = new Set(config?.updateable_settings ?? []);
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({
    key,
    value: resolve(key, config, group),
    description: SETTINGS[key].description,
    modifiable: isMain || enabledKeys.has(key),
    group_modifiable: enabledKeys.has(key),
  }));
}
