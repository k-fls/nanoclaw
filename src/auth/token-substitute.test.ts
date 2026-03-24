import { describe, it, expect, beforeEach } from 'vitest';

import { TokenSubstituteEngine, InMemoryTokenResolver } from './token-substitute.js';
import type { SubstituteConfig } from './oauth-types.js';
import { DEFAULT_SUBSTITUTE_CONFIG, MIN_RANDOM_CHARS } from './oauth-types.js';

describe('TokenSubstituteEngine', () => {
  let engine: TokenSubstituteEngine;
  let resolver: InMemoryTokenResolver;

  beforeEach(() => {
    resolver = new InMemoryTokenResolver();
    engine = new TokenSubstituteEngine(resolver);
  });

  const defaultAttrs = {};
  const scope = 'test-group';

  // ── generateSubstitute ─────────────────────────────────────────────

  describe('generateSubstitute', () => {
    it('preserves prefix and suffix of sk-ant-api tokens', () => {
      const real = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDE';
      const config: SubstituteConfig = { prefixLen: 14, suffixLen: 4, delimiters: '-' };
      const sub = engine.generateSubstitute(real, 'anthropic', defaultAttrs, scope, config);

      expect(sub).not.toBeNull();
      expect(sub!.startsWith('sk-ant-api03-a')).toBe(true);
      expect(sub!.endsWith('BCDE')).toBe(true);
      expect(sub!.length).toBe(real.length);
      expect(sub).not.toBe(real);
    });

    it('preserves prefix and suffix of Google ya29 tokens', () => {
      const real = 'ya29.a0AfH6SMBx1234567890abcdefghijklmnopqrstuvwxyz';
      const config: SubstituteConfig = { prefixLen: 10, suffixLen: 4, delimiters: '.' };
      const sub = engine.generateSubstitute(real, 'google', defaultAttrs, scope, config);

      expect(sub).not.toBeNull();
      expect(sub!.startsWith('ya29.a0AfH')).toBe(true);
      expect(sub!.slice(-4)).toBe(real.slice(-4));
      expect(sub!.length).toBe(real.length);
    });

    it('preserves prefix of ghp_ tokens', () => {
      const real = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234';
      const config: SubstituteConfig = { prefixLen: 4, suffixLen: 0, delimiters: '_' };
      const sub = engine.generateSubstitute(real, 'github', defaultAttrs, scope, config);

      expect(sub).not.toBeNull();
      expect(sub!.startsWith('ghp_')).toBe(true);
      expect(sub!.length).toBe(real.length);
    });

    it('preserves delimiter positions in middle section', () => {
      const real = 'prefix-aaa-bbb-ccc-ddd-eee-fff-ggg-suffix';
      const config: SubstituteConfig = { prefixLen: 6, suffixLen: 6, delimiters: '-' };
      const sub = engine.generateSubstitute(real, 'test', defaultAttrs, scope, config);

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
      const config: SubstituteConfig = { prefixLen: 6, suffixLen: 6, delimiters: '-' };
      const sub = engine.generateSubstitute(real, 'test', defaultAttrs, scope, config);

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
      const config: SubstituteConfig = { prefixLen: 10, suffixLen: 4, delimiters: '_' };
      expect(engine.generateSubstitute(real, 'test', defaultAttrs, scope, config)).toBeNull();
    });

    it('returns null when middle has fewer than MIN_RANDOM_CHARS non-delimiter chars', () => {
      const real = 'abcde12345fghij';
      const config: SubstituteConfig = { prefixLen: 5, suffixLen: 5, delimiters: '' };
      expect(15 - 10).toBeLessThan(MIN_RANDOM_CHARS);
      expect(engine.generateSubstitute(real, 'test', defaultAttrs, scope, config)).toBeNull();
    });

    it('stores the real token in the resolver and mapping in the engine', () => {
      const real = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDE';
      const config: SubstituteConfig = { prefixLen: 14, suffixLen: 4, delimiters: '-' };
      const sub = engine.generateSubstitute(real, 'anthropic', { tenant: 'acme' }, scope, config)!;

      // Engine has the mapping
      const resolved = engine.resolveSubstitute(sub, scope);
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
      expect(resolved!.mapping.providerId).toBe('anthropic');
      expect(resolved!.mapping.scopeAttrs).toEqual({ tenant: 'acme' });
      expect(resolved!.mapping.containerScope).toBe(scope);

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
      expect(engine.resolveSubstitute('anything', 'nonexistent')).toBeNull();
    });

    it('isolates substitutes between scopes', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const sub = engine.generateSubstitute(real, 'test', {}, 'scope-A', config)!;

      expect(engine.resolveSubstitute(sub, 'scope-A')).not.toBeNull();
      expect(engine.resolveSubstitute(sub, 'scope-B')).toBeNull();
    });

    it('returns null if resolver no longer has the token', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const sub = engine.generateSubstitute(real, 'test', {}, scope, config)!;

      // Revoke from resolver directly
      resolver.revoke(scope);

      // Engine still has mapping, but resolver returns null
      expect(engine.resolveSubstitute(sub, scope)).toBeNull();
    });
  });

  // ── resolveWithRestriction ─────────────────────────────────────────

  describe('resolveWithRestriction', () => {
    const config = DEFAULT_SUBSTITUTE_CONFIG;
    const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';

    it('allows when requiredAttrs is empty', () => {
      const sub = engine.generateSubstitute(real, 'test', { tenant: 'acme' }, scope, config)!;
      const resolved = engine.resolveWithRestriction(sub, scope, {});
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
    });

    it('allows when attrs match', () => {
      const sub = engine.generateSubstitute(real, 'test', { tenant: 'acme' }, scope, config)!;
      expect(engine.resolveWithRestriction(sub, scope, { tenant: 'acme' })).not.toBeNull();
    });

    it('blocks when attrs mismatch (cross-tenant injection)', () => {
      const sub = engine.generateSubstitute(real, 'test', { tenant: 'acme' }, scope, config)!;
      expect(engine.resolveWithRestriction(sub, scope, { tenant: 'evil-corp' })).toBeNull();
    });

    it('allows when entry has attrs but requiredAttrs does not have that key', () => {
      const sub = engine.generateSubstitute(real, 'microsoft', { tenant: 'contoso' }, scope, config)!;
      expect(engine.resolveWithRestriction(sub, scope, {})).not.toBeNull();
    });

    it('returns null for unknown substitute', () => {
      expect(engine.resolveWithRestriction('nope', scope, { tenant: 'acme' })).toBeNull();
    });

    it('returns null for wrong scope', () => {
      const sub = engine.generateSubstitute(real, 'test', {}, 'scope-A', config)!;
      expect(engine.resolveWithRestriction(sub, 'scope-B', {})).toBeNull();
    });
  });

  // ── InMemoryTokenResolver.update ───────────────────────────────────

  describe('InMemoryTokenResolver.update', () => {
    it('updates the real token behind a handle (refresh)', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const oldReal = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const newReal = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const sub = engine.generateSubstitute(oldReal, 'test', {}, scope, config)!;
      const resolved = engine.resolveSubstitute(sub, scope)!;
      expect(resolved.realToken).toBe(oldReal);

      // Update via resolver (using the handle from the mapping)
      resolver.update(resolved.mapping.handle, newReal);

      // Engine now resolves to new token
      expect(engine.resolveSubstitute(sub, scope)!.realToken).toBe(newReal);
    });

    it('scoped update does not affect other scopes', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const newReal = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const subA = engine.generateSubstitute(real, 'test', {}, 'scope-A', config)!;
      const subB = engine.generateSubstitute(real, 'test', {}, 'scope-B', config)!;

      // Update only scope-A's token
      const resolvedA = engine.resolveSubstitute(subA, 'scope-A')!;
      resolver.update(resolvedA.mapping.handle, newReal);

      expect(engine.resolveSubstitute(subA, 'scope-A')!.realToken).toBe(newReal);
      expect(engine.resolveSubstitute(subB, 'scope-B')!.realToken).toBe(real);
    });
  });

  // ── revokeByScope ──────────────────────────────────────────────────

  describe('revokeByScope', () => {
    const config = DEFAULT_SUBSTITUTE_CONFIG;
    const real1 = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
    const real2 = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJ';

    it('revokes all substitutes for a scope', () => {
      engine.generateSubstitute(real1, 'a', {}, 'group-1', config);
      engine.generateSubstitute(real2, 'b', {}, 'group-2', config);
      expect(engine.size).toBe(2);

      const revoked = engine.revokeByScope('group-1');
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
      expect(engine.revokeByScope('nonexistent')).toBe(0);
    });
  });
});
