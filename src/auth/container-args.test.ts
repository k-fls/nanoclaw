import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { RegisteredGroup } from '../types.js';
import type { DockerEnvName } from './docker-env.js';

// Mock logger to capture warnings
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock registry — control which providers exist
const mockBuiltinProviders: Array<{
  id: string;
  provision: () => { env: Partial<Record<DockerEnvName, string>> };
}> = [];
const mockDiscoveryIds: string[] = [];
const mockDiscoveryProviders = new Map<string, { id: string; envVars?: Record<string, string>; substituteConfig: any }>();

vi.mock('./registry.js', () => ({
  getAllProviders: () => mockBuiltinProviders,
  getAllDiscoveryProviderIds: () => mockDiscoveryIds,
  getDiscoveryProvider: (id: string) => mockDiscoveryProviders.get(id),
}));

// Mock provision.ts — return env vars based on what the discovery provider defines
vi.mock('./provision.js', () => ({
  provisionEnvVars: (provider: any, _group: any, _engine: any) => {
    if (!provider.envVars) return {};
    // Simulate: each envVar that has a value gets a substitute
    const env: Record<string, string> = {};
    for (const [envName] of Object.entries(provider.envVars)) {
      env[envName] = `sub_${envName}_${provider.id ?? 'unknown'}`;
    }
    return env;
  },
}));

const { injectSubstituteCredentials } = await import('./container-args.js');
const { logger } = await import('../logger.js');

function makeGroup(folder: string): RegisteredGroup {
  return { name: folder, folder, trigger: '@test', added_at: new Date().toISOString() };
}

describe('injectSubstituteCredentials', () => {
  beforeEach(() => {
    mockBuiltinProviders.length = 0;
    mockDiscoveryIds.length = 0;
    mockDiscoveryProviders.clear();
    vi.mocked(logger.warn).mockClear();
  });

  it('injects builtin env vars via Docker -e and returns discovery vars for file', () => {
    mockBuiltinProviders.push({
      id: 'claude',
      provision: () => ({ env: { ANTHROPIC_API_KEY: 'sub_key' } }),
    });
    mockDiscoveryIds.push('github');
    mockDiscoveryProviders.set('github', {
      id: 'github',
      envVars: { GH_TOKEN: 'oauth' },
      substituteConfig: {},
    });

    const args: string[] = [];
    const envFileVars = injectSubstituteCredentials(args, makeGroup('test'), {} as any);

    // Builtin provider goes to Docker -e args
    expect(args).toContain('-e');
    expect(args).toContain('ANTHROPIC_API_KEY=sub_key');

    // Discovery provider goes to env file vars (not in Docker -e)
    expect(envFileVars).toEqual({ GH_TOKEN: 'sub_GH_TOKEN_github' });
    expect(args).not.toContain('GH_TOKEN=sub_GH_TOKEN_github');
  });

  it('logs warning and skips when env var is claimed by another provider', () => {
    mockBuiltinProviders.push({
      id: 'builtin-a',
      provision: () => ({ env: { ANTHROPIC_API_KEY: 'sub_a' } }),
    });
    mockDiscoveryIds.push('discovery-b');
    mockDiscoveryProviders.set('discovery-b', {
      id: 'discovery-b',
      envVars: { ANTHROPIC_API_KEY: 'oauth' },
      substituteConfig: {},
    });

    const args: string[] = [];
    const envFileVars = injectSubstituteCredentials(args, makeGroup('test'), {} as any);

    // First provider wins (builtin via Docker -e)
    expect(args.filter(a => a.startsWith('ANTHROPIC_API_KEY='))).toEqual(['ANTHROPIC_API_KEY=sub_a']);
    // Discovery collision not in env file vars
    expect(envFileVars).toEqual({});

    // Warning logged for the duplicate
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        envVar: 'ANTHROPIC_API_KEY',
        provider: 'discovery-b',
        existingProvider: 'builtin-a',
      }),
      expect.any(String),
    );
  });

  it('allows different env vars from different providers', () => {
    mockDiscoveryIds.push('github', 'slack');
    mockDiscoveryProviders.set('github', {
      id: 'github',
      envVars: { GH_TOKEN: 'oauth' },
      substituteConfig: {},
    });
    mockDiscoveryProviders.set('slack', {
      id: 'slack',
      envVars: { SLACK_TOKEN: 'oauth' },
      substituteConfig: {},
    });

    const args: string[] = [];
    const envFileVars = injectSubstituteCredentials(args, makeGroup('test'), {} as any);

    // Both go to env file vars (discovery providers)
    expect(envFileVars).toEqual({
      GH_TOKEN: 'sub_GH_TOKEN_github',
      SLACK_TOKEN: 'sub_SLACK_TOKEN_slack',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs warning when two discovery providers claim the same env var', () => {
    mockDiscoveryIds.push('provider-a', 'provider-b');
    mockDiscoveryProviders.set('provider-a', {
      id: 'provider-a',
      envVars: { SHARED_VAR: 'oauth' },
      substituteConfig: {},
    });
    mockDiscoveryProviders.set('provider-b', {
      id: 'provider-b',
      envVars: { SHARED_VAR: 'oauth' },
      substituteConfig: {},
    });

    const args: string[] = [];
    const envFileVars = injectSubstituteCredentials(args, makeGroup('test'), {} as any);

    // First discovery provider wins
    expect(envFileVars).toEqual({ SHARED_VAR: 'sub_SHARED_VAR_provider-a' });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        envVar: 'SHARED_VAR',
        provider: 'provider-b',
        existingProvider: 'provider-a',
      }),
      expect.any(String),
    );
  });

  it('returns empty env file vars when no discovery providers exist', () => {
    mockBuiltinProviders.push({
      id: 'claude',
      provision: () => ({ env: { ANTHROPIC_API_KEY: 'sub_key' } }),
    });

    const args: string[] = [];
    const envFileVars = injectSubstituteCredentials(args, makeGroup('test'), {} as any);

    expect(args).toContain('ANTHROPIC_API_KEY=sub_key');
    expect(envFileVars).toEqual({});
  });
});
