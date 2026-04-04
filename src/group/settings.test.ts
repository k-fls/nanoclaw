import { describe, it, expect } from 'vitest';

import {
  applySetting,
  buildSettingsSnapshot,
  getGroupMaxMessages,
  getGroupRequiresTrigger,
  getGroupTimeout,
  getGroupTimezone,
  getGroupTrigger,
  getGroupTriggerUsers,
  isSettingKey,
  resolve,
} from './settings.js';
import { ContainerConfig, RegisteredGroup } from '../types.js';

const GROUP: RegisteredGroup = {
  name: 'Test',
  folder: 'test-group',
  trigger: '@Bot',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: false,
};

describe('isSettingKey', () => {
  it('returns true for valid keys', () => {
    expect(isSettingKey('timezone')).toBe(true);
    expect(isSettingKey('trigger')).toBe(true);
    expect(isSettingKey('maxMessages')).toBe(true);
  });

  it('returns false for invalid keys', () => {
    expect(isSettingKey('nonexistent')).toBe(false);
    expect(isSettingKey('additionalMounts')).toBe(false);
    expect(isSettingKey('')).toBe(false);
  });
});

describe('resolvers', () => {
  it('returns config value when set', () => {
    const config: ContainerConfig = { timezone: 'America/New_York' };
    expect(getGroupTimezone(config)).toBe('America/New_York');
  });

  it('falls back to legacy group field for trigger', () => {
    expect(getGroupTrigger(undefined, GROUP)).toBe('@Bot');
    expect(getGroupTrigger({}, GROUP)).toBe('@Bot');
  });

  it('config trigger overrides legacy group trigger', () => {
    const config: ContainerConfig = { trigger: '@NewBot' };
    expect(getGroupTrigger(config, GROUP)).toBe('@NewBot');
  });

  it('falls back to legacy group field for requiresTrigger', () => {
    expect(getGroupRequiresTrigger(undefined, GROUP)).toBe(false);
    expect(getGroupRequiresTrigger({}, GROUP)).toBe(false);
  });

  it('config requiresTrigger overrides legacy', () => {
    const config: ContainerConfig = { requiresTrigger: true };
    expect(getGroupRequiresTrigger(config, GROUP)).toBe(true);
  });

  it('returns null for triggerUsers when not set', () => {
    expect(getGroupTriggerUsers(undefined)).toBeNull();
    expect(getGroupTriggerUsers({})).toBeNull();
  });

  it('returns triggerUsers array when set', () => {
    const config: ContainerConfig = { triggerUsers: ['user1', 'user2'] };
    expect(getGroupTriggerUsers(config)).toEqual(['user1', 'user2']);
  });

  it('returns global defaults when config is undefined', () => {
    expect(typeof getGroupTimezone(undefined)).toBe('string');
    expect(typeof getGroupTimeout(undefined)).toBe('number');
    expect(typeof getGroupMaxMessages(undefined)).toBe('number');
    expect(getGroupRequiresTrigger(undefined)).toBe(true);
  });

  it('resolve() works with key string', () => {
    const config: ContainerConfig = { timezone: 'Europe/London' };
    expect(resolve('timezone', config, GROUP)).toBe('Europe/London');
    expect(resolve('trigger', config, GROUP)).toBe('@Bot');
  });
});

describe('applySetting', () => {
  it('applies valid timezone', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'timezone', 'America/Chicago')).toBeNull();
    expect(config.timezone).toBe('America/Chicago');
  });

  it('rejects invalid timezone', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'timezone', 'Not/A/Zone')).toBe(
      'Invalid IANA timezone',
    );
    expect(config.timezone).toBeUndefined();
  });

  it('rejects non-string timezone', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'timezone', 123)).toBe('Invalid IANA timezone');
  });

  it('applies valid trigger', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'trigger', '@NewName')).toBeNull();
    expect(config.trigger).toBe('@NewName');
  });

  it('rejects empty trigger', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'trigger', '')).toBe(
      'Trigger must be a non-empty string',
    );
  });

  it('rejects trigger over 50 chars', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'trigger', 'x'.repeat(51))).toBe(
      'Trigger must be 50 characters or fewer',
    );
  });

  it('applies valid requiresTrigger', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'requiresTrigger', false)).toBeNull();
    expect(config.requiresTrigger).toBe(false);
  });

  it('rejects non-boolean requiresTrigger', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'requiresTrigger', 'yes')).toBe(
      'Must be a boolean',
    );
  });

  it('applies valid triggerUsers', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'triggerUsers', ['user1', 'user2'])).toBeNull();
    expect(config.triggerUsers).toEqual(['user1', 'user2']);
  });

  it('rejects non-array triggerUsers', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'triggerUsers', 'user1')).toBe(
      'Must be an array of strings',
    );
  });

  it('rejects triggerUsers with non-string entries', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'triggerUsers', [1, 2])).toBe(
      'Must be an array of strings',
    );
  });

  it('applies valid timeout', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'timeout', 60000)).toBeNull();
    expect(config.timeout).toBe(60000);
  });

  it('rejects timeout out of range', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'timeout', 100)).toBe(
      'Must be between 30000 (30s) and 7200000 (2h)',
    );
    expect(applySetting(config, 'timeout', 9999999)).toBe(
      'Must be between 30000 (30s) and 7200000 (2h)',
    );
  });

  it('applies valid maxMessages', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'maxMessages', 20)).toBeNull();
    expect(config.maxMessages).toBe(20);
  });

  it('rejects maxMessages out of range', () => {
    const config: ContainerConfig = {};
    expect(applySetting(config, 'maxMessages', 0)).toBe(
      'Must be between 1 and 100',
    );
    expect(applySetting(config, 'maxMessages', 101)).toBe(
      'Must be between 1 and 100',
    );
  });
});

describe('buildSettingsSnapshot', () => {
  it('returns all setting keys', () => {
    const snapshot = buildSettingsSnapshot(undefined, GROUP, false);
    const keys = snapshot.map((s) => s.key);
    expect(keys).toContain('timezone');
    expect(keys).toContain('trigger');
    expect(keys).toContain('requiresTrigger');
    expect(keys).toContain('triggerUsers');
    expect(keys).toContain('timeout');
    expect(keys).toContain('maxMessages');
  });

  it('marks all settings as updatable for main group', () => {
    const snapshot = buildSettingsSnapshot(undefined, GROUP, true);
    for (const s of snapshot) {
      expect(s.updatable).toBe(true);
    }
  });

  it('marks only enabled settings as updatable for non-main', () => {
    const config: ContainerConfig = {
      updateable_settings: ['timezone', 'requiresTrigger'],
    };
    const snapshot = buildSettingsSnapshot(config, GROUP, false);
    const tz = snapshot.find((s) => s.key === 'timezone')!;
    const trigger = snapshot.find((s) => s.key === 'trigger')!;
    const req = snapshot.find((s) => s.key === 'requiresTrigger')!;
    expect(tz.updatable).toBe(true);
    expect(req.updatable).toBe(true);
    expect(trigger.updatable).toBe(false);
  });

  it('group_update_enabled reflects updateable_settings regardless of isMain', () => {
    const config: ContainerConfig = {
      updateable_settings: ['timezone'],
    };
    const mainSnapshot = buildSettingsSnapshot(config, GROUP, true);
    const groupSnapshot = buildSettingsSnapshot(config, GROUP, false);

    const mainTz = mainSnapshot.find((s) => s.key === 'timezone')!;
    const mainTrigger = mainSnapshot.find((s) => s.key === 'trigger')!;
    const groupTz = groupSnapshot.find((s) => s.key === 'timezone')!;
    const groupTrigger = groupSnapshot.find((s) => s.key === 'trigger')!;

    // group_update_enabled is the same for both
    expect(mainTz.group_update_enabled).toBe(true);
    expect(mainTrigger.group_update_enabled).toBe(false);
    expect(groupTz.group_update_enabled).toBe(true);
    expect(groupTrigger.group_update_enabled).toBe(false);

    // updatable differs: main can always update
    expect(mainTrigger.updatable).toBe(true);
    expect(groupTrigger.updatable).toBe(false);
  });

  it('no updateable_settings means nothing is group_update_enabled', () => {
    const snapshot = buildSettingsSnapshot(undefined, GROUP, false);
    for (const s of snapshot) {
      expect(s.group_update_enabled).toBe(false);
      expect(s.updatable).toBe(false);
    }
  });

  it('includes resolved values from config', () => {
    const config: ContainerConfig = { timezone: 'Asia/Tokyo', maxMessages: 25 };
    const snapshot = buildSettingsSnapshot(config, GROUP, false);
    expect(snapshot.find((s) => s.key === 'timezone')!.value).toBe(
      'Asia/Tokyo',
    );
    expect(snapshot.find((s) => s.key === 'maxMessages')!.value).toBe(25);
  });

  it('includes descriptions for all settings', () => {
    const snapshot = buildSettingsSnapshot(undefined, GROUP, false);
    for (const s of snapshot) {
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});
