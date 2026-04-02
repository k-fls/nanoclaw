import { describe, it, expect } from 'vitest';

import {
  buildHostMatch,
  buildPathPattern,
  parseDiscoveryFile,
} from './discovery-loader.js';
import type { DiscoveryFile } from './discovery-loader.js';

// ---------------------------------------------------------------------------
// buildHostMatch
// ---------------------------------------------------------------------------

describe('buildHostMatch', () => {
  it('fixed host → exact anchor, no hostPattern', () => {
    const result = buildHostMatch('api.anthropic.com');
    expect(result).not.toBeNull();
    expect(result!.anchor).toBe('api.anthropic.com');
    expect(result!.hostPattern).toBeUndefined();
    expect(result!.scopeKeys).toEqual([]);
  });

  it('templated host → suffix anchor + regex with named group', () => {
    const result = buildHostMatch('{tenant}.auth0.com');
    expect(result).not.toBeNull();
    expect(result!.anchor).toBe('auth0.com');
    expect(result!.hostPattern).toBeDefined();
    expect(result!.scopeKeys).toEqual(['tenant']);

    // Regex should match
    expect(result!.hostPattern!.test('myco.auth0.com')).toBe(true);
    expect(result!.hostPattern!.test('auth0.com')).toBe(false);
    expect(result!.hostPattern!.test('evil.notauth0.com')).toBe(false);

    // Named group extraction
    const match = 'myco.auth0.com'.match(result!.hostPattern!);
    expect(match?.groups?.tenant).toBe('myco');
  });

  it('multi-placeholder host → multiple scope keys', () => {
    const result = buildHostMatch('{domain}.auth.{region}.amazoncognito.com');
    expect(result).not.toBeNull();
    expect(result!.anchor).toBe('amazoncognito.com');
    expect(result!.scopeKeys).toContain('domain');
    expect(result!.scopeKeys).toContain('region');

    expect(
      result!.hostPattern!.test('myapp.auth.us-east-1.amazoncognito.com'),
    ).toBe(true);
    const match = 'myapp.auth.us-east-1.amazoncognito.com'.match(
      result!.hostPattern!,
    );
    expect(match?.groups?.domain).toBe('myapp');
    expect(match?.groups?.region).toBe('us-east-1');
  });

  it('fully templated host → null', () => {
    expect(buildHostMatch('{custom_domain}')).toBeNull();
  });

  it('{org}.okta.com → anchor okta.com', () => {
    const result = buildHostMatch('{org}.okta.com');
    expect(result).not.toBeNull();
    expect(result!.anchor).toBe('okta.com');
    expect(result!.hostPattern!.test('dev-123456.okta.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPathPattern
// ---------------------------------------------------------------------------

describe('buildPathPattern', () => {
  it('exact path match', () => {
    const re = buildPathPattern('/oauth/token', false);
    expect(re.test('/oauth/token')).toBe(true);
    expect(re.test('/oauth/token/extra')).toBe(false);
    expect(re.test('/other')).toBe(false);
  });

  it('prefix path match', () => {
    const re = buildPathPattern('/api/v2', true);
    expect(re.test('/api/v2')).toBe(true);
    expect(re.test('/api/v2/users')).toBe(true);
    expect(re.test('/api/v3')).toBe(false);
  });

  it('path with placeholders', () => {
    const re = buildPathPattern('/admin/api/{api_version}', true);
    expect(re.test('/admin/api/2024-01')).toBe(true);
    expect(re.test('/admin/api/2024-01/products.json')).toBe(true);
    expect(re.test('/other')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDiscoveryFile
// ---------------------------------------------------------------------------

describe('parseDiscoveryFile', () => {
  it('skips files that produce no usable rules', () => {
    const data: DiscoveryFile = {
      _note: 'aws-iam uses sigv4 not oauth',
    };
    expect(parseDiscoveryFile('aws-iam', data)).toBeNull();
  });

  it('skips files with only secondary endpoints (revocation/userinfo)', () => {
    const data: DiscoveryFile = {
      revocation_endpoint: 'https://example.com/revoke',
      userinfo_endpoint: 'https://example.com/userinfo',
    };
    expect(parseDiscoveryFile('secondary-only', data)).toBeNull();
  });

  it('includes secondary endpoints when primary rules exist', () => {
    const data: DiscoveryFile = {
      token_endpoint: 'https://example.com/token',
      userinfo_endpoint: 'https://example.com/userinfo',
    };
    const provider = parseDiscoveryFile('with-secondary', data);
    expect(provider).not.toBeNull();
    const modes = provider!.rules.map((r) => r.mode);
    expect(modes).toContain('token-exchange');
    expect(modes).toContain('bearer-swap'); // userinfo added as secondary
  });

  it('parses anthropic.json (fixed hosts, split-host)', () => {
    const data: DiscoveryFile = {
      authorization_endpoint: 'https://console.anthropic.com/oauth/authorize',
      token_endpoint: 'https://console.anthropic.com/v1/oauth/token',
      api_base_url: 'https://api.anthropic.com',
    };
    const provider = parseDiscoveryFile('anthropic', data);
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe('anthropic');
    expect(provider!.scopeKeys).toEqual([]);

    // Should have rules for both hosts
    const anchors = new Set(provider!.rules.map((r) => r.anchor));
    expect(anchors.has('console.anthropic.com')).toBe(true);
    expect(anchors.has('api.anthropic.com')).toBe(true);

    // Should have all three modes
    const modes = new Set(provider!.rules.map((r) => r.mode));
    expect(modes.has('token-exchange')).toBe(true);
    expect(modes.has('authorize-stub')).toBe(true);
    expect(modes.has('bearer-swap')).toBe(true);
  });

  it('parses auth0.json (templated host)', () => {
    const data: DiscoveryFile = {
      authorization_endpoint: 'https://{tenant}.auth0.com/authorize',
      token_endpoint: 'https://{tenant}.auth0.com/oauth/token',
      userinfo_endpoint: 'https://{tenant}.auth0.com/userinfo',
      revocation_endpoint: 'https://{tenant}.auth0.com/oauth/revoke',
    };
    const provider = parseDiscoveryFile('auth0', data);
    expect(provider).not.toBeNull();
    expect(provider!.scopeKeys).toContain('tenant');

    // All rules should have anchor auth0.com
    for (const rule of provider!.rules) {
      expect(rule.anchor).toBe('auth0.com');
      expect(rule.hostPattern).toBeDefined();
    }
  });

  it('parses google.json (multi-host split)', () => {
    const data: DiscoveryFile = {
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
    };
    const provider = parseDiscoveryFile('google', data);
    expect(provider).not.toBeNull();

    const anchors = new Set(provider!.rules.map((r) => r.anchor));
    expect(anchors.has('accounts.google.com')).toBe(true);
    expect(anchors.has('oauth2.googleapis.com')).toBe(true);
    expect(anchors.has('openidconnect.googleapis.com')).toBe(true);
  });

  it('parses zendesk.json (scoped attrs from templated host)', () => {
    const data: DiscoveryFile = {
      authorization_endpoint:
        'https://{subdomain}.zendesk.com/oauth/authorizations/new',
      token_endpoint: 'https://{subdomain}.zendesk.com/oauth/tokens',
      api_base_url: 'https://{subdomain}.zendesk.com/api/v2',
    };
    const provider = parseDiscoveryFile('zendesk', data);
    expect(provider).not.toBeNull();
    expect(provider!.scopeKeys).toContain('subdomain');

    // Bearer-swap rule should have prefix match for api path
    const bearerSwapRule = provider!.rules.find(
      (r) => r.mode === 'bearer-swap' && r.pathPattern.source.includes('api'),
    );
    expect(bearerSwapRule).toBeDefined();
    expect(bearerSwapRule!.pathPattern.test('/api/v2/tickets')).toBe(true);
  });

  it('parses github.json (split-host with api_base_url)', () => {
    const data: DiscoveryFile = {
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
      userinfo_endpoint: 'https://api.github.com/user',
      api_base_url: 'https://api.github.com',
    };
    const provider = parseDiscoveryFile('github', data);
    expect(provider).not.toBeNull();

    const anchors = new Set(provider!.rules.map((r) => r.anchor));
    expect(anchors.has('github.com')).toBe(true);
    expect(anchors.has('api.github.com')).toBe(true);
  });

  it('uses _token_format when provided', () => {
    const data: DiscoveryFile = {
      token_endpoint: 'https://example.com/oauth/token',
      authorization_endpoint: 'https://example.com/oauth/authorize',
      _token_format: { prefixLen: 14, suffixLen: 4, delimiters: '-' },
    };
    const provider = parseDiscoveryFile('custom', data);
    expect(provider).not.toBeNull();
    expect(provider!.substituteConfig.prefixLen).toBe(14);
    expect(provider!.substituteConfig.suffixLen).toBe(4);
    expect(provider!.substituteConfig.delimiters).toBe('-');
  });

  it('uses _api_hosts for additional bearer-swap rules', () => {
    const data: DiscoveryFile = {
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      _api_hosts: ['www.googleapis.com', 'sheets.googleapis.com'],
    };
    const provider = parseDiscoveryFile('google-extended', data);
    expect(provider).not.toBeNull();

    const bearerAnchors = provider!.rules
      .filter((r) => r.mode === 'bearer-swap')
      .map((r) => r.anchor);
    expect(bearerAnchors).toContain('www.googleapis.com');
    expect(bearerAnchors).toContain('sheets.googleapis.com');
  });

  it('generates catch-all bearer-swap when no api_base_url', () => {
    const data: DiscoveryFile = {
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
      // No api_base_url — should generate catch-all bearer-swap for example.com
    };
    const provider = parseDiscoveryFile('minimal', data);
    expect(provider).not.toBeNull();

    const bearerRules = provider!.rules.filter((r) => r.mode === 'bearer-swap');
    expect(bearerRules.length).toBeGreaterThan(0);
    expect(bearerRules.some((r) => r.anchor === 'example.com')).toBe(true);
  });

  it('handles cognito (multi-placeholder)', () => {
    const data: DiscoveryFile = {
      authorization_endpoint:
        'https://{domain}.auth.{region}.amazoncognito.com/oauth2/authorize',
      token_endpoint:
        'https://{domain}.auth.{region}.amazoncognito.com/oauth2/token',
    };
    const provider = parseDiscoveryFile('cognito', data);
    expect(provider).not.toBeNull();
    expect(provider!.scopeKeys).toContain('domain');
    expect(provider!.scopeKeys).toContain('region');
    expect(provider!.rules[0].anchor).toBe('amazoncognito.com');
  });
});
