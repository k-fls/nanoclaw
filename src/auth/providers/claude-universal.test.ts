/**
 * Tests for Claude's universal OAuth integration:
 * - CLAUDE_OAUTH_PROVIDER definition
 */
import { describe, it, expect } from 'vitest';

import {
  CLAUDE_OAUTH_PROVIDER,
  CLAUDE_SUBSTITUTE_CONFIG,
  claudeProvider,
} from './claude.js';
import {
  TokenSubstituteEngine,
  PersistentTokenResolver,
  type TokenRole,
} from '../token-substitute.js';
import { asGroupScope } from '../oauth-types.js';
import type { RegisteredGroup } from '../../types.js';

/** Create a minimal RegisteredGroup for test provision calls. */
function makeGroup(folder: string): RegisteredGroup {
  return {
    name: `Group ${folder}`,
    folder,
    trigger: '@test',
    added_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed engine with a real token and return provision() result. */
function generateSubstitute(
  engine: TokenSubstituteEngine,
  scope: string,
  realToken: string,
  role: TokenRole = 'access',
): { env: Record<string, string> } {
  engine.generateSubstitute(
    realToken,
    claudeProvider.id,
    {},
    asGroupScope(scope),
    CLAUDE_SUBSTITUTE_CONFIG,
    role,
  );
  return claudeProvider.provision(makeGroup(scope), engine);
}

// ---------------------------------------------------------------------------
// CLAUDE_OAUTH_PROVIDER definition
// ---------------------------------------------------------------------------

describe('CLAUDE_OAUTH_PROVIDER', () => {
  it('has correct provider ID', () => {
    expect(CLAUDE_OAUTH_PROVIDER.id).toBe('claude');
  });

  it('has token-exchange rule for platform.claude.com', () => {
    const rule = CLAUDE_OAUTH_PROVIDER.rules.find(
      (r) => r.mode === 'token-exchange',
    );
    expect(rule).toBeDefined();
    expect(rule!.anchor).toBe('platform.claude.com');
    expect(rule!.pathPattern.test('/v1/oauth/token')).toBe(true);
    expect(rule!.pathPattern.test('/v1/messages')).toBe(false);
  });

  it('has bearer-swap rule for api.anthropic.com', () => {
    const rule = CLAUDE_OAUTH_PROVIDER.rules.find(
      (r) => r.mode === 'bearer-swap' && r.anchor === 'api.anthropic.com',
    );
    expect(rule).toBeDefined();
    expect(rule!.pathPattern.test('/v1/messages')).toBe(true);
  });

  it('has bearer-swap rule for platform.claude.com', () => {
    const rule = CLAUDE_OAUTH_PROVIDER.rules.find(
      (r) => r.mode === 'bearer-swap' && r.anchor === 'platform.claude.com',
    );
    expect(rule).toBeDefined();
  });

  it('has substitute config with 14-char prefix for sk-ant-* tokens', () => {
    expect(CLAUDE_SUBSTITUTE_CONFIG.prefixLen).toBe(14);
    expect(CLAUDE_SUBSTITUTE_CONFIG.suffixLen).toBe(0);
    expect(CLAUDE_SUBSTITUTE_CONFIG.delimiters).toBe('-_');
  });
});

// ---------------------------------------------------------------------------
// provision with token engine
// ---------------------------------------------------------------------------

describe('provision with token engine', () => {
  it('returns substitute for api_key with sk-ant-api prefix preserved', () => {
    const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
    const real = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const { env } = generateSubstitute(engine, 'scope', real, 'api_key');
    expect(env.ANTHROPIC_API_KEY).toBeDefined();
    expect(env.ANTHROPIC_API_KEY.slice(0, 14)).toBe(real.slice(0, 14));
    expect(env.ANTHROPIC_API_KEY).not.toBe(real);
    expect(env.ANTHROPIC_API_KEY.length).toBe(real.length);
  });

  it('returns substitute for access token with sk-ant-oat prefix preserved', () => {
    const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
    const real = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const { env } = generateSubstitute(engine, 'scope', real);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN.slice(0, 14)).toBe(real.slice(0, 14));
  });

  it('does not expose refresh token in env', () => {
    const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
    const realAccess =
      'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const realRefresh =
      'sk-ant-ort01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    generateSubstitute(engine, 'scope', realAccess);
    generateSubstitute(engine, 'scope', realRefresh, 'refresh');

    const { env } = claudeProvider.provision(makeGroup('scope'), engine);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(env.CLAUDE_REFRESH_TOKEN).toBeUndefined();
  });

  it('returns empty env when no substitutes exist', () => {
    const engine = new TokenSubstituteEngine(new PersistentTokenResolver());
    const { env } = claudeProvider.provision(makeGroup('empty-scope'), engine);
    expect(env).toEqual({});
  });
});
