import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { muteLogger, restoreLogger } from '../test-helpers.js';
import {
  TokenSubstituteEngine,
  PersistentCredentialResolver,
  pickSubstituteConfigForToken,
} from './token-substitute.js';
import { initCredentialStore } from './store.js';
import type { SubstituteConfig, Credential } from './oauth-types.js';
import {
  DEFAULT_SUBSTITUTE_CONFIG,
  DEFAULT_ALNUM_SUBSTITUTE_CONFIG,
  MIN_RANDOM_CHARS,
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
  asGroupScope,
  asCredentialScope,
} from './oauth-types.js';

// Every test calls generateSubstitute or resolver.store, both of which trigger
// "Token persistence failed" warnings (credential store not initialized in tests).
describe('TokenSubstituteEngine', () => {
  let engine: TokenSubstituteEngine;
  let resolver: PersistentCredentialResolver;
  let logSpies: ReturnType<typeof muteLogger>;

  beforeEach(() => {
    initCredentialStore();
    resolver = new PersistentCredentialResolver();
    engine = new TokenSubstituteEngine(resolver);
    logSpies = muteLogger();
  });

  afterEach(() => {
    restoreLogger(logSpies);
  });

  const defaultAttrs = {};
  const scope = asGroupScope('test-group');
  const credScope = asCredentialScope('test-group');

  /** Store a credential then generate a substitute. */
  function storeAndGenerate(
    real: string,
    providerId: string,
    scopeAttrs: Record<string, string>,
    groupScope: typeof scope,
    config: SubstituteConfig,
    credentialPath = CRED_OAUTH,
  ): string {
    resolver.store(providerId, asCredentialScope(groupScope as string), credentialPath.split('/')[0], {
      value: real,
      expires_ts: 0,
      updated_ts: Date.now(),
    });
    const sub = engine.generateSubstitute(
      real, providerId, scopeAttrs, groupScope, config, credentialPath,
    );
    if (!sub) throw new Error('generateSubstitute returned null');
    return sub;
  }

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

    it('resolves the real token when credential is stored first', () => {
      const real = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDE';
      const config: SubstituteConfig = {
        prefixLen: 14,
        suffixLen: 4,
        delimiters: '-',
      };
      const sub = storeAndGenerate(real, 'anthropic', { tenant: 'acme' }, scope, config);

      const resolved = engine.resolveSubstitute(sub, scope);
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
      expect(resolved!.mapping.providerId).toBe('anthropic');
      expect(resolved!.mapping.scopeAttrs).toEqual({ tenant: 'acme' });
      expect(resolved!.mapping.credentialScope).toBe(scope);
      expect(resolver.size).toBe(1);
    });

    it('honors config.minRandomChars override (below MIN_RANDOM_CHARS)', () => {
      // 16-char pure alnum: default (prefix 10 + suffix 4) → middle 2 chars → would fail
      // with 4/4 and minRandom 8 → middle 8 chars → passes.
      const real = 'ABCDEFGHIJKL1234';
      const sub = engine.generateSubstitute(
        real, 'test', defaultAttrs, scope, DEFAULT_ALNUM_SUBSTITUTE_CONFIG,
      );
      expect(sub).not.toBeNull();
      expect(sub!.length).toBe(real.length);
      expect(sub!.slice(0, 4)).toBe('ABCD');
      expect(sub!.slice(-4)).toBe('1234');
    });

    it('still returns null when below config.minRandomChars floor', () => {
      // 10-char alnum: 4 prefix + 4 suffix → 2 middle → less than minRandom 8 → null.
      const real = 'ABCDEF1234';
      expect(
        engine.generateSubstitute(
          real, 'test', defaultAttrs, scope, DEFAULT_ALNUM_SUBSTITUTE_CONFIG,
        ),
      ).toBeNull();
    });
  });

  // ── pickSubstituteConfigForToken ───────────────────────────────────

  describe('pickSubstituteConfigForToken', () => {
    it('returns alnum config for pure alphanumeric tokens', () => {
      expect(pickSubstituteConfigForToken('abc123DEF456ghiJKL')).toBe(
        DEFAULT_ALNUM_SUBSTITUTE_CONFIG,
      );
    });

    it('returns default config for tokens with delimiters', () => {
      expect(pickSubstituteConfigForToken('abc-123.def_456')).toBe(
        DEFAULT_SUBSTITUTE_CONFIG,
      );
      expect(pickSubstituteConfigForToken('sk-ant-api03-abc')).toBe(
        DEFAULT_SUBSTITUTE_CONFIG,
      );
    });

    it('returns default config for tokens with non-alnum non-delimiter chars', () => {
      // Anything that isn't [A-Za-z0-9] falls back to DEFAULT.
      expect(pickSubstituteConfigForToken('has whitespace xyz')).toBe(
        DEFAULT_SUBSTITUTE_CONFIG,
      );
    });
  });

  // ── getOrCreateSubstitute shape-aware fallback ─────────────────────

  describe('getOrCreateSubstitute shape-aware default', () => {
    it('uses alnum config when caller passes DEFAULT and token is pure alnum', () => {
      // 24-char alnum fails DEFAULT (needs ≥30) but passes ALNUM default.
      const real = 'ABCDEFGH12345678ijklmnop';
      resolver.store('searchapi', credScope, CRED_OAUTH, {
        value: real,
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      const sub = engine.getOrCreateSubstitute(
        'searchapi', {}, scope, DEFAULT_SUBSTITUTE_CONFIG, CRED_OAUTH,
      );

      expect(sub).not.toBeNull();
      expect(sub!.length).toBe(real.length);
      // Alnum config has prefixLen 4
      expect(sub!.slice(0, 4)).toBe('ABCD');
      expect(sub!.slice(-4)).toBe('mnop');
    });

    it('respects explicit config — does not swap away from caller-provided config', () => {
      // Provider passes a narrow config with minRandomChars 4 — must be honored,
      // not overridden by the generic ALNUM default (which would have prefixLen 4).
      const real = 'XYZ12345ABCDE';
      resolver.store('narrow', credScope, CRED_OAUTH, {
        value: real,
        expires_ts: 0,
        updated_ts: Date.now(),
      });
      const explicitConfig: SubstituteConfig = {
        prefixLen: 3,
        suffixLen: 3,
        delimiters: '',
        minRandomChars: 4,
      };
      const sub = engine.getOrCreateSubstitute(
        'narrow', {}, scope, explicitConfig, CRED_OAUTH,
      );

      expect(sub).not.toBeNull();
      expect(sub!.slice(0, 3)).toBe('XYZ');
      expect(sub!.slice(-3)).toBe('CDE');
    });

    it('returns null when token is too short even for alnum default', () => {
      // 10-char alnum: 4 + 4 + 2 middle < 8 → null even with shape-aware swap.
      const real = 'ABCDEF1234';
      resolver.store('tiny', credScope, CRED_OAUTH, {
        value: real,
        expires_ts: 0,
        updated_ts: Date.now(),
      });
      const sub = engine.getOrCreateSubstitute(
        'tiny', {}, scope, DEFAULT_SUBSTITUTE_CONFIG, CRED_OAUTH,
      );
      expect(sub).toBeNull();
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
      const sub = storeAndGenerate(real, 'test', {}, asGroupScope('scope-A'), config);

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
      resolver.delete(asCredentialScope(scope as string));

      // Engine still has mapping, but resolver returns null
      expect(engine.resolveSubstitute(sub, scope)).toBeNull();
    });
  });

  // ── resolveWithRestriction ─────────────────────────────────────────

  describe('resolveWithRestriction', () => {
    const config = DEFAULT_SUBSTITUTE_CONFIG;
    const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';

    it('allows when requiredAttrs is empty', () => {
      const sub = storeAndGenerate(real, 'test', { tenant: 'acme' }, scope, config);
      const resolved = engine.resolveWithRestriction(sub, scope, {});
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
    });

    it('allows when attrs match', () => {
      const sub = storeAndGenerate(real, 'test', { tenant: 'acme' }, scope, config);
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
      const sub = storeAndGenerate(real, 'microsoft', { tenant: 'contoso' }, scope, config);
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

  // ── PersistentCredentialResolver role-based storage ─────────────────────

  describe('PersistentCredentialResolver', () => {
    const cred = (value: string): Credential => ({
      value, expires_ts: 0, updated_ts: Date.now(),
    });

    it('caches oauth credentials in memory', () => {
      resolver.store('provider', asCredentialScope('scope'), CRED_OAUTH, cred('real_access'));
      expect(
        resolver.resolve(asCredentialScope('scope'), 'provider', CRED_OAUTH)?.value,
      ).toBe('real_access');
    });

    it('caches api_key credentials in memory', () => {
      resolver.store('provider', asCredentialScope('scope'), 'api_key', cred('sk-ant-api03-key'));
      expect(
        resolver.resolve(asCredentialScope('scope'), 'provider', 'api_key')?.value,
      ).toBe('sk-ant-api03-key');
    });

    it('resolves by scope+provider+credentialId', () => {
      resolver.delete(asCredentialScope('group-a'));
      resolver.store('claude', asCredentialScope('group-a'), CRED_OAUTH, cred('access_tok'));
      resolver.store('github', asCredentialScope('group-a'), CRED_OAUTH, cred('access_tok2'));

      expect(
        resolver.resolve(asCredentialScope('group-a'), 'claude', CRED_OAUTH)?.value,
      ).toBe('access_tok');
      expect(
        resolver.resolve(asCredentialScope('group-a'), 'github', CRED_OAUTH)?.value,
      ).toBe('access_tok2');
    });

    it('returns null for non-existent combination', () => {
      resolver.delete(asCredentialScope('group-a'));
      resolver.delete(asCredentialScope('group-b'));
      resolver.store('claude', asCredentialScope('group-a'), CRED_OAUTH, cred('tok'));
      expect(
        resolver.resolve(asCredentialScope('group-a'), 'claude', 'api_key'),
      ).toBeNull();
      expect(
        resolver.resolve(asCredentialScope('group-b'), 'claude', CRED_OAUTH),
      ).toBeNull();
      expect(
        resolver.resolve(asCredentialScope('group-a'), 'github', CRED_OAUTH),
      ).toBeNull();
    });
  });

  // ── Cache behavior ────────────────────────────────────────────────

  describe('cache behavior', () => {
    it('resolve returns plaintext for both value and refresh', () => {
      const r = new PersistentCredentialResolver();
      const scope = asCredentialScope('cache-refresh-enc');

      r.store('prov', scope, CRED_OAUTH, {
        value: 'real_access',
        expires_ts: 0,
        updated_ts: Date.now(),
        refresh: { value: 'real_refresh', expires_ts: 0, updated_ts: Date.now() },
      });

      const resolved = r.resolve(scope, 'prov', CRED_OAUTH);
      expect(resolved).not.toBeNull();
      expect(resolved!.value).toBe('real_access');
      expect(resolved!.refresh).toBeDefined();
      expect(resolved!.refresh!.value).toBe('real_refresh');
      expect(r.extractToken(resolved!, 'refresh')).toBe('real_refresh');
    });

    it('caches expiry on the credential object', () => {
      const r = new PersistentCredentialResolver();
      const scope = asCredentialScope('expiry-test');
      const expiresTs = Date.now() + 60_000;

      r.store('prov', scope, CRED_OAUTH, {
        value: 'tok', expires_ts: expiresTs, updated_ts: Date.now(),
      });

      const cred = r.resolve(scope, 'prov', CRED_OAUTH);
      expect(cred).not.toBeNull();
      expect(cred!.expires_ts).toBe(expiresTs);
    });

    it('round-tripping resolved credential through store does not double-encrypt', () => {
      const r = new PersistentCredentialResolver();
      const scope = asCredentialScope('roundtrip-test');

      r.store('prov', scope, CRED_OAUTH, {
        value: 'access_tok',
        expires_ts: 0,
        updated_ts: Date.now(),
        refresh: { value: 'refresh_tok', expires_ts: 0, updated_ts: Date.now() },
      });

      // Resolve (plaintext), modify, store again
      const cred = r.resolve(scope, 'prov', CRED_OAUTH)!;
      cred.expires_ts = 99999;
      r.store('prov', scope, CRED_OAUTH, cred);

      // Values must survive the round-trip intact
      const after = r.resolve(scope, 'prov', CRED_OAUTH)!;
      expect(after.value).toBe('access_tok');
      expect(after.refresh!.value).toBe('refresh_tok');
      expect(after.expires_ts).toBe(99999);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes a specific provider from cache and disk', () => {
      const r = new PersistentCredentialResolver();
      const scope = asCredentialScope('del-provider');

      r.store('prov-a', scope, CRED_OAUTH, {
        value: 'tok_a', expires_ts: 0, updated_ts: Date.now(),
      });
      r.store('prov-b', scope, CRED_OAUTH, {
        value: 'tok_b', expires_ts: 0, updated_ts: Date.now(),
      });

      r.delete(scope, 'prov-a');

      // prov-a gone from cache and disk (fresh resolver can't find it)
      expect(r.resolve(scope, 'prov-a', CRED_OAUTH)).toBeNull();
      const fresh = new PersistentCredentialResolver();
      expect(fresh.resolve(scope, 'prov-a', CRED_OAUTH)).toBeNull();

      // prov-b still present
      expect(r.resolve(scope, 'prov-b', CRED_OAUTH)?.value).toBe('tok_b');
    });

    it('deletes entire scope directory when no providerId given', () => {
      const r = new PersistentCredentialResolver();
      const scope = asCredentialScope('del-scope');

      r.store('prov-a', scope, CRED_OAUTH, {
        value: 'tok_a', expires_ts: 0, updated_ts: Date.now(),
      });
      r.store('prov-b', scope, CRED_OAUTH, {
        value: 'tok_b', expires_ts: 0, updated_ts: Date.now(),
      });

      r.delete(scope);

      // Both providers gone from cache and disk
      expect(r.resolve(scope, 'prov-a', CRED_OAUTH)).toBeNull();
      expect(r.resolve(scope, 'prov-b', CRED_OAUTH)).toBeNull();
      const fresh = new PersistentCredentialResolver();
      expect(fresh.resolve(scope, 'prov-a', CRED_OAUTH)).toBeNull();
      expect(fresh.resolve(scope, 'prov-b', CRED_OAUTH)).toBeNull();
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

    it('defaults credentialPath to oauth', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const real = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890ab';

      const sub = storeAndGenerate(real, 'claude', {}, scope, config);

      // Mapping defaults to CRED_OAUTH credentialPath
      const resolved = engine.resolveSubstitute(sub, scope);
      expect(resolved).not.toBeNull();
      expect(resolved!.mapping.credentialPath).toBe(CRED_OAUTH);
    });
  });

  // ── PersistentCredentialResolver.update ───────────────────────────────────

  describe('PersistentCredentialResolver.update', () => {
    it('updates the real token for a scope+provider+role', () => {
      const config = DEFAULT_SUBSTITUTE_CONFIG;
      const oldReal = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const newReal = 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz';

      const sub = storeAndGenerate(oldReal, 'test', {}, scope, config);
      const resolved = engine.resolveSubstitute(sub, scope)!;
      expect(resolved.realToken).toBe(oldReal);

      // Update via resolver using mapping identity (credentialId, not full path)
      const m = resolved.mapping;
      const credentialId = m.credentialPath.split('/')[0];
      resolver.store(m.providerId, m.credentialScope, credentialId, {
        value: newReal, expires_ts: 0, updated_ts: Date.now(),
      });

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
      resolver.store('test', asCredentialScope('scope-A'), CRED_OAUTH, {
        value: newReal, expires_ts: 0, updated_ts: Date.now(),
      });

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
      const resolver2 = new PersistentCredentialResolver();
      // Store the real token so the new resolver can find it
      resolver2.store('multi', asCredentialScope(scope as string), CRED_OAUTH, {
        value: real, expires_ts: 0, updated_ts: Date.now(),
      });
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
      storeAndGenerate(real1, 'a', {}, asGroupScope('group-1'), config);
      storeAndGenerate(real2, 'b', {}, asGroupScope('group-2'), config);
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

  // ── generateSubstitute does not store credentials ─────────────────
  // Callers must store via resolver.store() before or after. generateSubstitute
  // only creates the mapping. This test documents the intended contract.

  describe('generateSubstitute contract', () => {
    it('does not store the real token — caller must store explicitly', () => {
      const real = 'tok_abcdefghijklmnopqrstuvwxyz1234567890abcdefghij';
      const isolatedScope = asGroupScope('contract-test');
      const provId = 'contract-prov';
      const credScope = asCredentialScope(isolatedScope as string);

      // Clean stale disk state from interrupted previous runs
      resolver.delete(credScope, provId);

      const sub = engine.generateSubstitute(
        real, provId, {}, isolatedScope, DEFAULT_SUBSTITUTE_CONFIG,
      )!;
      expect(sub).not.toBeNull();

      // resolveSubstitute returns null because no credential was stored
      expect(engine.resolveSubstitute(sub, isolatedScope)).toBeNull();

      // After explicit store, it resolves
      resolver.store(provId, credScope, CRED_OAUTH, {
        value: real, expires_ts: 0, updated_ts: Date.now(),
      });
      const resolved = engine.resolveSubstitute(sub, isolatedScope);
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);

      // Clean up disk state to avoid polluting future runs
      resolver.delete(credScope, provId);
    });

  });

  // ── sharedOp ──────────────────────────────────────────────────────

  describe('sharedOp', () => {
    it('runs the operation and returns its result', async () => {
      const result = await engine.sharedOp(
        credScope,
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

      const p1 = engine.sharedOp(credScope, 'provider', 'refresh', fn);
      const p2 = engine.sharedOp(credScope, 'provider', 'refresh', fn);

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

      await engine.sharedOp(credScope, 'provider', 'refresh', fn);
      await engine.sharedOp(credScope, 'provider', 'refresh', fn);

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

      const p1 = engine.sharedOp(credScope, 'provider', 'refresh', fn);
      const p2 = engine.sharedOp(credScope, 'provider', 'store', fn);

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

      const p1 = engine.sharedOp(credScope, 'providerA', 'refresh', fn);
      const p2 = engine.sharedOp(credScope, 'providerB', 'refresh', fn);

      resolve(true);

      await p1;
      await p2;
      expect(callCount).toBe(2);
    });

    it('coalesces calls with the same resolved credential scope', async () => {
      // Both callers pass the same resolved scope — they coalesce.
      const sharedScope = asCredentialScope('group-a');

      let callCount = 0;
      let resolve!: (v: boolean) => void;
      const blocker = new Promise<boolean>((r) => {
        resolve = r;
      });

      const fn = () => {
        callCount++;
        return blocker;
      };

      const p1 = engine.sharedOp(sharedScope, 'provider', 'refresh', fn);
      const p2 = engine.sharedOp(sharedScope, 'provider', 'refresh', fn);

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

      const p1 = engine.sharedOp(credScope, 'provider', 'refresh', () => blocker);
      const p2 = engine.sharedOp(credScope, 'provider', 'refresh', () => blocker);

      resolve();

      await expect(p1).rejects.toThrow('boom');
      await expect(p2).rejects.toThrow('boom');
    });

    it('clears inflight entry after error so next call runs fresh', async () => {
      let callCount = 0;

      await engine
        .sharedOp(credScope, 'provider', 'refresh', async () => {
          callCount++;
          throw new Error('fail');
        })
        .catch(() => {});

      await engine.sharedOp(credScope, 'provider', 'refresh', async () => {
        callCount++;
        return true;
      });

      expect(callCount).toBe(2);
    });
  });

  // ── Credential info files ─────────────────────────────────────────

  describe('credential info file', () => {
    let tmpGroupDir: string;
    let groupFolderMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const os = await import('os');
      tmpGroupDir = fs.mkdtempSync(path.join(os.default.tmpdir(), 'nanoclaw-credinfo-'));
      const groupFolder = await import('../group-folder.js');
      groupFolderMock = vi
        .spyOn(groupFolder, 'resolveGroupFolderPath')
        .mockReturnValue(tmpGroupDir);
    });

    afterEach(() => {
      groupFolderMock.mockRestore();
      fs.rmSync(tmpGroupDir, { recursive: true, force: true });
    });

    function providerPath(providerId: string): string {
      return path.join(tmpGroupDir, 'credentials', 'tokens', `${providerId}.jsonl`);
    }

    function readLines(providerId: string): Record<string, unknown>[] {
      return fs.readFileSync(providerPath(providerId), 'utf-8')
        .trim().split('\n').map((l) => JSON.parse(l));
    }

    it('writes per-provider JSONL file with substitute', () => {
      const real = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';
      const sub = storeAndGenerate(real, 'github', {}, scope, DEFAULT_SUBSTITUTE_CONFIG);

      const lines = readLines('github');
      expect(lines).toEqual([
        { provider: 'github', name: CRED_OAUTH, token: sub },
      ]);
    });

    it('excludes nested paths from output', () => {
      const realAccess = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';
      const realRefresh = 'ghp_refreshXXXXXXXXXXXXXXXXXXXXXXXXXXXXab';
      const sub = storeAndGenerate(realAccess, 'github', {}, scope, DEFAULT_SUBSTITUTE_CONFIG, CRED_OAUTH);
      storeAndGenerate(realRefresh, 'github', {}, scope, DEFAULT_SUBSTITUTE_CONFIG, CRED_OAUTH_REFRESH);

      const lines = readLines('github');
      expect(lines).toEqual([
        { provider: 'github', name: CRED_OAUTH, token: sub },
      ]);
    });

    it('sets borrowed flag when sourceScope is present', () => {
      const borrowingScope = asGroupScope('borrower');
      const defaultCredScope = asCredentialScope('default');
      const real = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';

      resolver.store('github', defaultCredScope, CRED_OAUTH, {
        value: real, expires_ts: 0, updated_ts: Date.now(),
      });

      const sub = engine.generateSubstitute(
        real, 'github', {}, borrowingScope, DEFAULT_SUBSTITUTE_CONFIG,
        CRED_OAUTH, defaultCredScope,
      )!;

      const lines = readLines('github');
      expect(lines).toEqual([
        { provider: 'github', name: CRED_OAUTH, token: sub, borrowed: true },
      ]);
    });

    it('removes file on revocation', () => {
      const real = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';
      storeAndGenerate(real, 'github', {}, scope, DEFAULT_SUBSTITUTE_CONFIG);
      expect(fs.existsSync(providerPath('github'))).toBe(true);

      engine.revokeByScope(scope, 'github');
      expect(fs.existsSync(providerPath('github'))).toBe(false);
    });

    it('writes separate files per provider', () => {
      const realOauth = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';
      const realApiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const subOauth = storeAndGenerate(realOauth, 'github', {}, scope, DEFAULT_SUBSTITUTE_CONFIG, CRED_OAUTH);

      resolver.store('other', asCredentialScope(scope as string), 'api_key', {
        value: realApiKey, expires_ts: 0, updated_ts: Date.now(),
      });
      const subApiKey = engine.generateSubstitute(
        realApiKey, 'other', {}, scope, DEFAULT_SUBSTITUTE_CONFIG, 'api_key',
      )!;

      expect(readLines('github')).toEqual([
        { provider: 'github', name: CRED_OAUTH, token: subOauth },
      ]);
      expect(readLines('other')).toEqual([
        { provider: 'other', name: 'api_key', token: subApiKey },
      ]);
    });
  });

  // ── resolveCredentialScope with per-key borrowing ─────────────────

  describe('resolveCredentialScope (per-key)', () => {
    it('returns own scope when group has its own key for that credentialPath', () => {
      const groupA = asGroupScope('own-keys-grp');
      engine.setGroupResolver(() => ({
        name: 'Own',
        folder: 'own-keys-grp',
        trigger: '',
        added_at: '',
      }));

      resolver.store('claude', asCredentialScope('own-keys-grp'), CRED_OAUTH, {
        value: 'tok_own_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      expect(engine.resolveCredentialScope(groupA, 'claude', CRED_OAUTH)).toBe(
        asCredentialScope('own-keys-grp'),
      );
    });

    it('falls back to credentialSource for a key the group does not own', () => {
      const borrower = asGroupScope('borrower-grp');
      engine.setGroupResolver((folder) => {
        if (folder === 'borrower-grp') {
          return {
            name: 'Borrower',
            folder: 'borrower-grp',
            trigger: '',
            added_at: '',
            containerConfig: { credentialSource: 'source-grp' },
          };
        }
        return undefined;
      });

      // No keys in borrower's own scope — only in source
      resolver.store('claude', asCredentialScope('source-grp'), CRED_OAUTH, {
        value: 'tok_source_xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      expect(engine.resolveCredentialScope(borrower, 'claude', CRED_OAUTH)).toBe(
        asCredentialScope('source-grp'),
      );
    });

    it('prefers own scope over credentialSource when own has the key', () => {
      const groupX = asGroupScope('both-grp');
      engine.setGroupResolver(() => ({
        name: 'Both',
        folder: 'both-grp',
        trigger: '',
        added_at: '',
        containerConfig: { credentialSource: 'shared-src' },
      }));

      resolver.store('claude', asCredentialScope('both-grp'), CRED_OAUTH, {
        value: 'tok_own_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });
      resolver.store('claude', asCredentialScope('shared-src'), CRED_OAUTH, {
        value: 'tok_shared_xxxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      expect(engine.resolveCredentialScope(groupX, 'claude', CRED_OAUTH)).toBe(
        asCredentialScope('both-grp'),
      );
    });

    it('returns own scope when credentialSource has no key either', () => {
      const empty = asGroupScope('empty-borrow');
      engine.setGroupResolver(() => ({
        name: 'Empty',
        folder: 'empty-borrow',
        trigger: '',
        added_at: '',
        containerConfig: { credentialSource: 'also-empty' },
      }));

      // Neither scope has keys
      expect(engine.resolveCredentialScope(empty, 'claude', CRED_OAUTH)).toBe(
        asCredentialScope('empty-borrow'),
      );
    });

    it('borrows oauth from source but uses own api_key (per-key)', () => {
      const group = asGroupScope('mixed-grp');
      engine.setGroupResolver(() => ({
        name: 'Mixed',
        folder: 'mixed-grp',
        trigger: '',
        added_at: '',
        containerConfig: { credentialSource: 'mixed-src' },
      }));

      // Group owns api_key
      resolver.store('claude', asCredentialScope('mixed-grp'), 'api_key', {
        value: 'sk-ant-api00-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });
      // Source owns oauth
      resolver.store('claude', asCredentialScope('mixed-src'), CRED_OAUTH, {
        value: 'tok_src_oauth_xxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      expect(engine.resolveCredentialScope(group, 'claude', 'api_key')).toBe(
        asCredentialScope('mixed-grp'),
      );
      expect(engine.resolveCredentialScope(group, 'claude', CRED_OAUTH)).toBe(
        asCredentialScope('mixed-src'),
      );
    });
  });

  // ── hasKeyInScope ─────────────────────────────────────────────────

  describe('hasKeyInScope', () => {
    it('finds credentials through resolver', () => {
      const credScope = asCredentialScope('has-key-scope');
      resolver.store('claude', credScope, CRED_OAUTH, {
        value: 'tok_borrowed_xxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      expect(engine.hasKeyInScope(credScope, 'claude', CRED_OAUTH)).toBe(true);
      expect(engine.hasKeyInScope(credScope, 'claude', 'api_key')).toBe(false);
    });
  });

  // ── revokeByScope with borrowed credentials ────────────────────────

  describe('revokeByScope with borrowed credentials', () => {
    it('does not delete keys from source scope (non-writable)', () => {
      const borrower = asGroupScope('revoke-borrow');
      const sourceCredScope = asCredentialScope('revoke-source');
      const real = 'tok_borrowed_revoke_xxxxxxxxxxxxxxxxxxxx';

      engine.setGroupResolver((folder) => {
        if (folder === 'revoke-borrow') {
          return {
            name: 'Borrower',
            folder: 'revoke-borrow',
            trigger: '',
            added_at: '',
            containerConfig: { credentialSource: 'revoke-source' },
          };
        }
        return undefined;
      });

      // Store credentials in source scope
      resolver.store('claude', sourceCredScope, CRED_OAUTH, {
        value: real,
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      // Generate substitute with sourceScope (borrowed)
      engine.generateSubstitute(
        real, 'claude', {}, borrower, DEFAULT_SUBSTITUTE_CONFIG,
        CRED_OAUTH, sourceCredScope,
      );
      expect(engine.size).toBe(1);

      // Revoke borrower's substitutes
      const revoked = engine.revokeByScope(borrower, 'claude');
      expect(revoked).toBe(1);
      expect(engine.size).toBe(0);

      // Source credentials should still exist
      expect(
        resolver.resolve(sourceCredScope, 'claude', CRED_OAUTH),
      ).not.toBeNull();
    });

    it('deletes keys from own scope (writable)', () => {
      const owner = asGroupScope('revoke-own');
      const ownCredScope = asCredentialScope('revoke-own');
      const real = 'tok_owned_revoke_xxxxxxxxxxxxxxxxxxxxxxx';

      engine.setGroupResolver(() => ({
        name: 'Owner',
        folder: 'revoke-own',
        trigger: '',
        added_at: '',
      }));

      resolver.store('claude', ownCredScope, CRED_OAUTH, {
        value: real,
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      storeAndGenerate(real, 'claude', {}, owner, DEFAULT_SUBSTITUTE_CONFIG);
      expect(engine.size).toBe(1);

      engine.revokeByScope(owner, 'claude');
      expect(engine.size).toBe(0);

      // Own credentials should be deleted
      expect(
        resolver.resolve(ownCredScope, 'claude', CRED_OAUTH),
      ).toBeNull();
    });
  });

  // ── getOrCreateSubstitute with borrowing ───────────────────────────

  describe('getOrCreateSubstitute with borrowing', () => {
    it('generates substitute from source scope when borrowing', () => {
      const borrower = asGroupScope('orcreate-borrow');
      const sourceCredScope = asCredentialScope('orcreate-source');
      const real = 'tok_orcreate_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

      engine.setGroupResolver((folder) => {
        if (folder === 'orcreate-borrow') {
          return {
            name: 'Borrower',
            folder: 'orcreate-borrow',
            trigger: '',
            added_at: '',
            containerConfig: { credentialSource: 'orcreate-source' },
          };
        }
        return undefined;
      });

      resolver.store('claude', sourceCredScope, CRED_OAUTH, {
        value: real,
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      const sub = engine.getOrCreateSubstitute(
        'claude', {}, borrower, DEFAULT_SUBSTITUTE_CONFIG,
      );
      expect(sub).not.toBeNull();

      // The substitute should resolve to the source's real token
      const resolved = engine.resolveSubstitute(sub!, borrower);
      expect(resolved).not.toBeNull();
      expect(resolved!.realToken).toBe(real);
    });

    it('returns null when neither own nor source has credentials', () => {
      const empty = asGroupScope('orcreate-empty');

      engine.setGroupResolver(() => ({
        name: 'Empty',
        folder: 'orcreate-empty',
        trigger: '',
        added_at: '',
        containerConfig: { credentialSource: 'nowhere' },
      }));

      const sub = engine.getOrCreateSubstitute(
        'claude', {}, empty, DEFAULT_SUBSTITUTE_CONFIG,
      );
      expect(sub).toBeNull();
    });
  });

  // ── envNames ──────────────────────────────────────────────────────

  describe('envNames', () => {
    const envScope = asGroupScope('env-scope');
    const envCredScope = asCredentialScope('env-scope');
    const envConfig: SubstituteConfig = { prefixLen: 4, suffixLen: 4, delimiters: '-' };

    function storeToken(providerId: string): void {
      resolver.store(providerId, envCredScope, CRED_OAUTH, {
        value: 'tok_env_test_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });
    }

    it('stores envNames on generateSubstitute', () => {
      storeToken('github');
      const sub = engine.generateSubstitute(
        'tok_env_test_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        'github', {}, envScope, envConfig, CRED_OAUTH, undefined,
        ['GH_TOKEN', 'GITHUB_TOKEN'],
      );
      expect(sub).not.toBeNull();

      const vars = engine.collectEnvVars(envScope);
      expect(vars.GH_TOKEN).toBe(sub);
      expect(vars.GITHUB_TOKEN).toBe(sub);
    });

    it('deduplicates envNames on generateSubstitute', () => {
      storeToken('dedup-gen');
      const sub = engine.generateSubstitute(
        'tok_env_test_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        'dedup-gen', {}, envScope, envConfig, CRED_OAUTH, undefined,
        ['MY_TOKEN', 'MY_TOKEN', 'MY_TOKEN'],
      );
      expect(sub).not.toBeNull();

      const vars = engine.collectEnvVars(envScope);
      // Only one entry for MY_TOKEN
      expect(Object.keys(vars).filter(k => k === 'MY_TOKEN')).toHaveLength(1);
    });

    it('getOrCreateSubstitute passes envNames to new substitutes', () => {
      storeToken('orcreate-env');
      const sub = engine.getOrCreateSubstitute(
        'orcreate-env', {}, envScope, envConfig, CRED_OAUTH,
        ['MY_VAR'],
      );
      expect(sub).not.toBeNull();

      const vars = engine.collectEnvVars(envScope);
      expect(vars.MY_VAR).toBe(sub);
    });

    it('getOrCreateSubstitute merges envNames into existing substitutes', () => {
      storeToken('merge-env');
      const sub1 = engine.getOrCreateSubstitute(
        'merge-env', {}, envScope, envConfig, CRED_OAUTH,
        ['FIRST_VAR'],
      );
      expect(sub1).not.toBeNull();

      // Call again with different envNames — should merge
      const sub2 = engine.getOrCreateSubstitute(
        'merge-env', {}, envScope, envConfig, CRED_OAUTH,
        ['SECOND_VAR'],
      );
      expect(sub2).toBe(sub1); // same substitute

      const vars = engine.collectEnvVars(envScope);
      expect(vars.FIRST_VAR).toBe(sub1);
      expect(vars.SECOND_VAR).toBe(sub1);
    });

    it('mergeEnvNames adds new names without duplicating', () => {
      storeToken('merge-dedup');
      const sub = engine.getOrCreateSubstitute(
        'merge-dedup', {}, envScope, envConfig, CRED_OAUTH,
        ['EXISTING'],
      );
      expect(sub).not.toBeNull();

      engine.mergeEnvNames(envScope, 'merge-dedup', sub!, ['EXISTING', 'NEW_ONE']);

      const vars = engine.collectEnvVars(envScope);
      expect(vars.EXISTING).toBe(sub);
      expect(vars.NEW_ONE).toBe(sub);
    });

    it('mergeEnvNames produces sorted output regardless of insertion order', () => {
      storeToken('merge-sort');
      const sub = engine.getOrCreateSubstitute(
        'merge-sort', {}, envScope, envConfig, CRED_OAUTH,
        ['ZEBRA', 'ALPHA'],
      );
      expect(sub).not.toBeNull();

      engine.mergeEnvNames(envScope, 'merge-sort', sub!, ['MIDDLE', 'BETA']);

      // Access the entry's envNames directly via collectEnvVars order isn't enough —
      // we need to verify the underlying array. Use getSubstitute + collectEnvVars.
      const ps = (engine as any).scopes.get(envScope)?.get('merge-sort');
      const entry = ps?.substitutes.get(sub!);
      expect(entry.envNames).toEqual(['ALPHA', 'BETA', 'MIDDLE', 'ZEBRA']);
    });

    it('mergeEnvNames is a no-op for unknown substitute', () => {
      // Should not throw
      engine.mergeEnvNames(envScope, 'nonexistent', 'fake_sub', ['FOO']);
    });

    it('collectEnvVars returns empty for scope with no substitutes', () => {
      const vars = engine.collectEnvVars(asGroupScope('empty-env'));
      expect(vars).toEqual({});
    });

    it('collectEnvVars aggregates across providers', () => {
      storeToken('provider-a');
      resolver.store('provider-b', envCredScope, CRED_OAUTH, {
        value: 'tok_env_bbbb_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        expires_ts: 0,
        updated_ts: Date.now(),
      });

      const subA = engine.generateSubstitute(
        'tok_env_test_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        'provider-a', {}, envScope, envConfig, CRED_OAUTH, undefined,
        ['TOKEN_A'],
      );
      const subB = engine.generateSubstitute(
        'tok_env_bbbb_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        'provider-b', {}, envScope, envConfig, CRED_OAUTH, undefined,
        ['TOKEN_B'],
      );

      const vars = engine.collectEnvVars(envScope);
      expect(vars.TOKEN_A).toBe(subA);
      expect(vars.TOKEN_B).toBe(subB);
    });

    it('omits entries without envNames from collectEnvVars', () => {
      storeToken('no-env');
      engine.generateSubstitute(
        'tok_env_test_xxxxxxxxxxxxxxxxxxxxxxxxxx',
        'no-env', {}, envScope, envConfig, CRED_OAUTH,
      );
      // No envNames set

      const vars = engine.collectEnvVars(envScope);
      expect(Object.keys(vars)).toHaveLength(0);
    });
  });
});
