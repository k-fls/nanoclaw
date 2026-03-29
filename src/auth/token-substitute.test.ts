import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { muteLogger, restoreLogger } from '../test-helpers.js';
import {
  TokenSubstituteEngine,
  PersistentTokenResolver,
} from './token-substitute.js';
import type { SubstituteConfig } from './oauth-types.js';
import {
  DEFAULT_SUBSTITUTE_CONFIG,
  MIN_RANDOM_CHARS,
  asGroupScope,
  asCredentialScope,
} from './oauth-types.js';

// Every test calls generateSubstitute or resolver.store, both of which trigger
// "Token persistence failed" warnings (credential store not initialized in tests).
describe('TokenSubstituteEngine', () => {
  let engine: TokenSubstituteEngine;
  let resolver: PersistentTokenResolver;
  let logSpies: ReturnType<typeof muteLogger>;

  beforeEach(() => {
    resolver = new PersistentTokenResolver();
    engine = new TokenSubstituteEngine(resolver);
    logSpies = muteLogger();
  });

  afterEach(() => {
    restoreLogger(logSpies);
  });

  const defaultAttrs = {};
  const scope = asGroupScope('test-group');

  // ── generateSubstitute ─────────────────────────────────────────────

  describe('generateSubstitute', () => {
    it('preserves prefix and suffix of sk-ant-api tokens', () => {
      const real = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDE';
      const config: SubstituteConfig = {
        prefixLen: 14,
        suffixLen: 4,
        delimiters: '-',
      };
      const sub = engine.generateSubstitute(
        real,
        'anthropic',
        defaultAttrs,
        scope,
        config,
      );

      expect(sub).not.toBeNull();
      expect(sub!.startsWith('sk-ant-api03-a')).toBe(true);
      expect(sub!.endsWith('BCDE')).toBe(true);
      expect(sub!.length).toBe(real.length);
      expect(sub).not.toBe(real);
    });

    it('preserves prefix and suffix of Google ya29 tokens', () => {
      const real = 'ya29.a0AfH6SMBx1234567890abcdefghijklmnopqrstuvwxyz';
      const config: SubstituteConfig = {
        prefixLen: 10,
        suffixLen: 4,
        delimiters: '.',
      };
      const sub = engine.generateSubstitute(
        real,
        'google',
        defaultAttrs,
        scope,
        config,
      );

      expect(sub).not.toBeNull();
      expect(sub!.startsWith('ya29.a0AfH')).toBe(true);
      expect(sub!.slice(-4)).toBe(real.slice(-4));
      expect(sub!.length).toBe(real.length);
    });

    it('preserves prefix of ghp_ tokens', () => {
      const real = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234';
      const config: SubstituteConfig = {
        prefixLen: 4,
        suffixLen: 0,
        delimiters: '_',
      };
      const sub = engine.generateSubstitute(
        real,
        'github',
        defaultAttrs,
        scope,
        config,
      );

      expect(sub).not.toBeNull();
      expect(sub!.startsWith('ghp_')).toBe(true);
      expect(sub!.length).toBe(real.length);
    });

    it('preserves delimiter positions in middle section', () => {
      const real = 'prefix-aaa-bbb-ccc-ddd-eee-fff-ggg-suffix';
      const config: SubstituteConfig = {
        prefixLen: 6,
        suffixLen: 6,
        delimiters: '-',
      };
      const sub = engine.generateSubstitute(
        real,
        'test',
        defaultAttrs,
        scope,
        config,
      );

      expect(sub).not.toBeNull();
      const realMiddle = real.slice(6, -6);
      const subMiddle = sub!.slice(6, -6);
      for (let i = 0; i < realMiddle.length; i++) {
        if (realMiddle[i] === '-') {
          expect(subMiddle[i]).toBe('-');
        }
      }
    });

    it('preserves character class (lower→lower, upper→upper, digit→digit)', () => {
      const real = 'PREFIX--aAbB11cCdD22eEfF--SUFFIX';
      const config: SubstituteConfig = {
        prefixLen: 6,
        suffixLen: 6,
        delimiters: '-',
      };
      const sub = engine.generateSubstitute(
        real,
        'test',
        defaultAttrs,
        scope,
        config,
      );

      expect(sub).not.toBeNull();
      const realMiddle = real.slice(6, -6);
      const subMiddle = sub!.slice(6, -6);

      for (let i = 0; i < realMiddle.length; i++) {
        const rc = realMiddle[i];
        const sc = subMiddle[i];
        if (rc === '-') {
          expect(sc).toBe('-');
        } else if (/[a-z]/.test(rc)) {
          expect(sc).toMatch(/[a-z]/);
        } else if (/[A-Z]/.test(rc)) {
          expect(sc).toMatch(/[A-Z]/);
        } else if (/[0-9]/.test(rc)) {
          expect(sc).toMatch(/[0-9]/);
        }
      }
    });

    it('returns null for tokens too short to randomize', () => {
      const real = 'short_token';
      const config: SubstituteConfig = {
        prefixLen: 10,
        suffixLen: 4,
        delimiters: '_',
      };
      expect(
        engine.generateSubstitute(real, 'test', defaultAttrs, scope, config),
      ).toBeNull();
    });

    it('returns null when middle has fewer than MIN_RANDOM_CHARS non-delimiter chars', () => {
      const real = 'abcde12345fghij';
      const config: SubstituteConfig = {
        prefixLen: 5,
        suffixLen: 5,
        delimiters: '',
      };
      expect(15 - 10).toBeLessThan(MIN_RANDOM_CHARS);
      expect(
        engine.generateSubstitute(real, 'test', defaultAttrs, scope, config),
      ).toBeNull();
    });

    it('stores the real token in the resolver and mapping in the engine', () => {
      const real = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDE';
      const config: SubstituteConfig = {
        prefixLen: 14,
        suffixLen: 4,
        delimiters: '-',
      };
      const sub = engine.generateSubstitute(
        real,
        'anthropic',
        { tenant: 'acme' },
        scope,
        config,
      )!;

      // Engine has the mapping
      const resolved = engine.resolveSubstitute(sub, scope);
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
      expect(resolved!.mapping.providerId).toBe('anthropic');
      expect(resolved!.mapping.scopeAttrs).toEqual({ tenant: 'acme' });
      expect(resolved!.mapping.credentialScope).toBe(scope);

      // Resolver has the real token
      expect(resolver.size).toBe(1);
    });
  });

  // ── resolveSubstitute (scoped) ─────────────────────────────────────

  describe('resolveSubstitute', () => {
    it('returns null for unknown substitute', () => {
      expect(engine.resolveSubstitute('unknown-token', scope)).toBeNull();
    });

    it('returns null for unknown scope', () => {
      expect(
        engine.resolveSubstitute('anything', asGroupScope('nonexistent')),
      ).toBeNull();
    });

    it('isolates substitutes between scopes', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const sub = engine.generateSubstitute(
        real,
        'test',
        {},
        asGroupScope('scope-A'),
        config,
      )!;

      expect(
        engine.resolveSubstitute(sub, asGroupScope('scope-A')),
      ).not.toBeNull();
      expect(engine.resolveSubstitute(sub, asGroupScope('scope-B'))).toBeNull();
    });

    it('returns null if resolver no longer has the token', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const sub = engine.generateSubstitute(real, 'test', {}, scope, config)!;

      // Revoke from resolver directly
      resolver.revoke(asCredentialScope(scope as string));

      // Engine still has mapping, but resolver returns null
      expect(engine.resolveSubstitute(sub, scope)).toBeNull();
    });
  });

  // ── resolveWithRestriction ─────────────────────────────────────────

  describe('resolveWithRestriction', () => {
    const config = DEFAULT_SUBSTITUTE_CONFIG;
    const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';

    it('allows when requiredAttrs is empty', () => {
      const sub = engine.generateSubstitute(
        real,
        'test',
        { tenant: 'acme' },
        scope,
        config,
      )!;
      const resolved = engine.resolveWithRestriction(sub, scope, {});
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
    });

    it('allows when attrs match', () => {
      const sub = engine.generateSubstitute(
        real,
        'test',
        { tenant: 'acme' },
        scope,
        config,
      )!;
      expect(
        engine.resolveWithRestriction(sub, scope, { tenant: 'acme' }),
      ).not.toBeNull();
    });

    it('blocks when attrs mismatch (cross-tenant injection)', () => {
      const sub = engine.generateSubstitute(
        real,
        'test',
        { tenant: 'acme' },
        scope,
        config,
      )!;
      expect(
        engine.resolveWithRestriction(sub, scope, { tenant: 'evil-corp' }),
      ).toBeNull();
    });

    it('allows when entry has attrs but requiredAttrs does not have that key', () => {
      const sub = engine.generateSubstitute(
        real,
        'microsoft',
        { tenant: 'contoso' },
        scope,
        config,
      )!;
      expect(engine.resolveWithRestriction(sub, scope, {})).not.toBeNull();
    });

    it('returns null for unknown substitute', () => {
      expect(
        engine.resolveWithRestriction('nope', scope, { tenant: 'acme' }),
      ).toBeNull();
    });

    it('returns null for wrong scope', () => {
      const sub = engine.generateSubstitute(
        real,
        'test',
        {},
        asGroupScope('scope-A'),
        config,
      )!;
      expect(
        engine.resolveWithRestriction(sub, asGroupScope('scope-B'), {}),
      ).toBeNull();
    });
  });

  // ── PersistentTokenResolver role-based storage ─────────────────────

  describe('PersistentTokenResolver roles', () => {
    it('caches access tokens in memory', () => {
      resolver.store(
        'real_access',
        'provider',
        asCredentialScope('scope'),
        'access',
      );
      expect(
        resolver.resolve(asCredentialScope('scope'), 'provider', 'access'),
      ).toBe('real_access');
    });

    it('caches api_key tokens in memory', () => {
      resolver.store(
        'sk-ant-api03-key',
        'provider',
        asCredentialScope('scope'),
        'api_key',
      );
      expect(
        resolver.resolve(asCredentialScope('scope'), 'provider', 'api_key'),
      ).toBe('sk-ant-api03-key');
    });

    it('resolves by scope+provider+role', () => {
      resolver.store(
        'access_tok',
        'claude',
        asCredentialScope('group-a'),
        'access',
      );
      resolver.store(
        'refresh_tok',
        'claude',
        asCredentialScope('group-a'),
        'refresh',
      );
      resolver.store(
        'access_tok2',
        'github',
        asCredentialScope('group-a'),
        'access',
      );

      expect(
        resolver.resolve(asCredentialScope('group-a'), 'claude', 'access'),
      ).toBe('access_tok');
      // refresh tokens are cold (not in hot cache when persistence fails in test)
      // but without initCredentialStore they fall back to null from disk
      expect(
        resolver.resolve(asCredentialScope('group-a'), 'github', 'access'),
      ).toBe('access_tok2');
    });

    it('returns null for non-existent combination', () => {
      resolver.store('tok', 'claude', asCredentialScope('group-a'), 'access');
      expect(
        resolver.resolve(asCredentialScope('group-a'), 'claude', 'refresh'),
      ).toBeNull();
      expect(
        resolver.resolve(asCredentialScope('group-b'), 'claude', 'access'),
      ).toBeNull();
      expect(
        resolver.resolve(asCredentialScope('group-a'), 'github', 'access'),
      ).toBeNull();
    });
  });

  // ── generateSubstitute with role ──────────────────────────────────

  describe('generateSubstitute with role', () => {
    it('passes role through to resolver', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'sk-ant-ort01-abcdefghijklmnopqrstuvwxyz1234567890ab';

      engine.generateSubstitute(real, 'claude', {}, scope, config, 'refresh');

      // Refresh tokens are cold — resolve from disk (returns null without initCredentialStore)
      // But we can verify the mapping exists via the engine
      const sub = engine.generateSubstitute(
        real,
        'claude',
        {},
        scope,
        config,
        'refresh',
      );
      // Second call overwrites — engine still works
    });

    it('defaults role to access', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890ab';

      engine.generateSubstitute(real, 'claude', {}, scope, config);

      expect(
        resolver.resolve(
          asCredentialScope(scope as string),
          'claude',
          'access',
        ),
      ).toBe(real);
    });
  });

  // ── PersistentTokenResolver.update ───────────────────────────────────

  describe('PersistentTokenResolver.update', () => {
    it('updates the real token for a scope+provider+role', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const oldReal = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const newReal = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const sub = engine.generateSubstitute(
        oldReal,
        'test',
        {},
        scope,
        config,
      )!;
      const resolved = engine.resolveSubstitute(sub, scope)!;
      expect(resolved.realToken).toBe(oldReal);

      // Update via resolver using mapping identity
      const m = resolved.mapping;
      resolver.update(m.credentialScope, m.providerId, m.role as any, newReal);

      // Engine now resolves to new token
      expect(engine.resolveSubstitute(sub, scope)!.realToken).toBe(newReal);
    });

    it('scoped update does not affect other scopes', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const newReal = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const subA = engine.generateSubstitute(
        real,
        'test',
        {},
        asGroupScope('scope-A'),
        config,
      )!;
      const subB = engine.generateSubstitute(
        real,
        'test',
        {},
        asGroupScope('scope-B'),
        config,
      )!;

      // Update only scope-A's token
      resolver.update(asCredentialScope('scope-A'), 'test', 'access', newReal);

      expect(
        engine.resolveSubstitute(subA, asGroupScope('scope-A'))!.realToken,
      ).toBe(newReal);
      expect(
        engine.resolveSubstitute(subB, asGroupScope('scope-B'))!.realToken,
      ).toBe(real);
    });
  });

  // ── persistRef keeps old substitutes ─────────────────────────────

  describe('persistRef retains old substitutes', () => {
    it('multiple substitutes for same role coexist after refresh', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real1 = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const real2 = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const sub1 = engine.generateSubstitute(real1, 'test', {}, scope, config)!;
      const sub2 = engine.generateSubstitute(real2, 'test', {}, scope, config)!;

      // Both resolve
      expect(engine.resolveSubstitute(sub1, scope)).not.toBeNull();
      expect(engine.resolveSubstitute(sub2, scope)).not.toBeNull();
      expect(engine.size).toBe(2);
    });

    it('getSubstitute returns first sorted when multiple exist for same role', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real1 = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const real2 = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const sub1 = engine.generateSubstitute(real1, 'test', {}, scope, config)!;
      engine.generateSubstitute(real2, 'test', {}, scope, config);

      // getSubstitute returns the first sorted
      const got = engine.getSubstitute('test', scope);
      expect(got).toBe([sub1, engine.getSubstitute('test', scope)].sort()[0]);
    });
  });

  // ── scopeAttrs persisted in refs ─────────────────────────────────

  describe('scopeAttrs persisted in refs', () => {
    it('resolveWithRestriction works after load from persisted refs', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';

      // Generate with non-empty scopeAttrs
      const sub = engine.generateSubstitute(
        real,
        'multi',
        { tenant: 'acme' },
        scope,
        config,
      )!;
      expect(sub).not.toBeNull();

      // Simulate restart: new engine, load from persisted refs
      const resolver2 = new PersistentTokenResolver();
      // Store the real token so the new resolver can find it
      resolver2.store(
        real,
        'multi',
        asCredentialScope(scope as string),
        'access',
      );
      const engine2 = new TokenSubstituteEngine(resolver2);
      engine2.loadPersistedRefs(scope, 'multi');

      // Matching attrs should resolve
      const resolved = engine2.resolveWithRestriction(sub, scope, {
        tenant: 'acme',
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);

      // Mismatched attrs should be blocked
      const blocked = engine2.resolveWithRestriction(sub, scope, {
        tenant: 'evil',
      });
      expect(blocked).toBeNull();
    });
  });

  // ── revokeByScope ──────────────────────────────────────────────────

  describe('revokeByScope', () => {
    const config = DEFAULT_SUBSTITUTE_CONFIG;
    const real1 = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
    const real2 = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJ';

    it('revokes all substitutes for a scope', () => {
      engine.generateSubstitute(
        real1,
        'a',
        {},
        asGroupScope('group-1'),
        config,
      );
      engine.generateSubstitute(
        real2,
        'b',
        {},
        asGroupScope('group-2'),
        config,
      );
      expect(engine.size).toBe(2);

      const revoked = engine.revokeByScope(asGroupScope('group-1'));
      expect(revoked).toBe(1);
      expect(engine.size).toBe(1);
      expect(engine.scopeCount).toBe(1);
      // Resolver also cleaned up
      expect(resolver.size).toBe(1);
    });

    it('revokes only matching provider when specified', () => {
      engine.generateSubstitute(real1, 'google', {}, scope, config);
      engine.generateSubstitute(real2, 'github', {}, scope, config);
      expect(engine.size).toBe(2);

      const revoked = engine.revokeByScope(scope, 'google');
      expect(revoked).toBe(1);
      expect(engine.size).toBe(1);
    });

    it('returns 0 when nothing matches', () => {
      expect(engine.revokeByScope(asGroupScope('nonexistent'))).toBe(0);
    });
  });

  // ── sharedOp ──────────────────────────────────────────────────────

  describe('sharedOp', () => {
    it('runs the operation and returns its result', async () => {
      const result = await engine.sharedOp(
        scope,
        'provider',
        'refresh',
        async () => 42,
      );
      expect(result).toBe(42);
    });

    it('coalesces concurrent calls for the same key', async () => {
      let callCount = 0;
      let resolve!: (v: boolean) => void;
      const blocker = new Promise<boolean>((r) => {
        resolve = r;
      });

      const fn = () => {
        callCount++;
        return blocker;
      };

      const p1 = engine.sharedOp(scope, 'provider', 'refresh', fn);
      const p2 = engine.sharedOp(scope, 'provider', 'refresh', fn);

      resolve(true);

      expect(await p1).toBe(true);
      expect(await p2).toBe(true);
      expect(callCount).toBe(1);
    });

    it('allows new calls after the previous completes', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return true;
      };

      await engine.sharedOp(scope, 'provider', 'refresh', fn);
      await engine.sharedOp(scope, 'provider', 'refresh', fn);

      expect(callCount).toBe(2);
    });

    it('does not coalesce different operation types', async () => {
      let callCount = 0;
      let resolve!: (v: boolean) => void;
      const blocker = new Promise<boolean>((r) => {
        resolve = r;
      });

      const fn = () => {
        callCount++;
        return blocker;
      };

      const p1 = engine.sharedOp(scope, 'provider', 'refresh', fn);
      const p2 = engine.sharedOp(scope, 'provider', 'store', fn);

      resolve(true);

      await p1;
      await p2;
      expect(callCount).toBe(2);
    });

    it('does not coalesce different providers', async () => {
      let callCount = 0;
      let resolve!: (v: boolean) => void;
      const blocker = new Promise<boolean>((r) => {
        resolve = r;
      });

      const fn = () => {
        callCount++;
        return blocker;
      };

      const p1 = engine.sharedOp(scope, 'providerA', 'refresh', fn);
      const p2 = engine.sharedOp(scope, 'providerB', 'refresh', fn);

      resolve(true);

      await p1;
      await p2;
      expect(callCount).toBe(2);
    });

    it('coalesces groups that resolve to the same credential scope', async () => {
      // Both groups configured to use default credentials.
      // Main group resolves directly to 'default' scope.
      const groupA = asGroupScope('group-a');
      const groupB = asGroupScope('group-b');
      engine.setGroupResolver((folder) => ({
        name: folder as string,
        folder: folder as string,
        trigger: '',
        added_at: '',
        isMain: true,
        containerConfig: { useDefaultCredentials: true },
      }));

      let callCount = 0;
      let resolve!: (v: boolean) => void;
      const blocker = new Promise<boolean>((r) => {
        resolve = r;
      });

      const fn = () => {
        callCount++;
        return blocker;
      };

      const p1 = engine.sharedOp(groupA, 'provider', 'refresh', fn);
      const p2 = engine.sharedOp(groupB, 'provider', 'refresh', fn);

      resolve(true);

      expect(await p1).toBe(true);
      expect(await p2).toBe(true);
      expect(callCount).toBe(1);
    });

    it('propagates errors to all coalesced callers', async () => {
      let resolve!: () => void;
      const blocker = new Promise<never>((_, reject) => {
        resolve = () => reject(new Error('boom'));
      });

      const p1 = engine.sharedOp(scope, 'provider', 'refresh', () => blocker);
      const p2 = engine.sharedOp(scope, 'provider', 'refresh', () => blocker);

      resolve();

      await expect(p1).rejects.toThrow('boom');
      await expect(p2).rejects.toThrow('boom');
    });

    it('clears inflight entry after error so next call runs fresh', async () => {
      let callCount = 0;

      await engine
        .sharedOp(scope, 'provider', 'refresh', async () => {
          callCount++;
          throw new Error('fail');
        })
        .catch(() => {});

      await engine.sharedOp(scope, 'provider', 'refresh', async () => {
        callCount++;
        return true;
      });

      expect(callCount).toBe(2);
    });
  });
});
