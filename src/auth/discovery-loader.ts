/**
 * Discovery file loader for the universal OAuth provider system.
 *
 * Reads docs/oauth-discovery/*.json at startup and converts each into
 * an OAuthProvider with InterceptRules. Adding a provider = dropping a JSON file.
 *
 * Handles:
 *   - Fixed hosts (api.anthropic.com → exact anchor)
 *   - Templated hosts ({tenant}.auth0.com → suffix anchor + hostPattern regex)
 *   - Split-host providers (Google: accounts.google.com + oauth2.googleapis.com)
 *   - Additional API hosts via _api_hosts field
 *   - Custom token format via _token_format field
 *
 * Skips files that lack token_endpoint AND authorization_endpoint (e.g. aws-iam.json).
 * Skips fully-templated hosts that produce no extractable anchor.
 */
import fs from 'fs';
import path from 'path';

import type {
  InterceptRule,
  OAuthProvider,
  SubstituteConfig,
} from './oauth-types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from './oauth-types.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Endpoint fields we extract rules from
// ---------------------------------------------------------------------------

interface EndpointDef {
  /** JSON field name in the discovery file. */
  field: string;
  /** Intercept mode for URLs from this field. */
  mode: InterceptRule['mode'];
  /** If true, pathPattern is a prefix match (api_base_url covers all sub-paths). */
  prefixMatch?: boolean;
}

const ENDPOINT_FIELDS: EndpointDef[] = [
  { field: 'token_endpoint', mode: 'token-exchange' },
  { field: 'authorization_endpoint', mode: 'authorize-stub' },
  { field: 'revocation_endpoint', mode: 'bearer-swap' },
  { field: 'userinfo_endpoint', mode: 'bearer-swap' },
  { field: 'api_base_url', mode: 'bearer-swap', prefixMatch: true },
];

// ---------------------------------------------------------------------------
// URL parsing helpers
// ---------------------------------------------------------------------------

/** Placeholder pattern in URLs: {name} */
const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * Parse a URL that may contain {placeholder} segments.
 * Returns the hostname and path, with placeholders intact.
 */
function parseEndpointUrl(url: string): { host: string; path: string } | null {
  // Simple regex parse to handle placeholders without URL constructor mangling them
  const m = url.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const host = m[1].replace(/:\d+$/, ''); // strip port if present
  const pathStr = m[2] || '/';
  return { host, path: pathStr };
}

/**
 * Build anchor and optional hostPattern from a hostname.
 *
 * Fixed host: anchor = exact host, no hostPattern.
 * Templated host: anchor = fixed suffix, hostPattern = regex with named groups.
 *
 * Returns null if the host is fully templated (no fixed suffix for anchor).
 */
export function buildHostMatch(host: string): {
  anchor: string;
  hostPattern?: RegExp;
  scopeKeys: string[];
} | null {
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(host)) {
    // Fixed host — exact anchor, no regex needed
    return { anchor: host, scopeKeys: [] };
  }

  // Extract the fixed suffix for the anchor.
  // e.g. "{tenant}.auth0.com" → "auth0.com"
  // e.g. "{domain}.auth.{region}.amazoncognito.com" → "amazoncognito.com"
  const parts = host.split('.');
  const fixedSuffix: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    PLACEHOLDER_RE.lastIndex = 0;
    if (PLACEHOLDER_RE.test(parts[i])) break;
    fixedSuffix.unshift(parts[i]);
  }

  if (fixedSuffix.length === 0) {
    // Fully templated (e.g. {custom_domain}) — no usable anchor
    return null;
  }

  const anchor = fixedSuffix.join('.');

  // Build regex: replace {name} with (?<name>[^.]+), escape the rest
  // Reset lastIndex since we reuse the global regex
  const regexSource = parts
    .map((part) => {
      PLACEHOLDER_RE.lastIndex = 0;
      if (PLACEHOLDER_RE.test(part)) {
        PLACEHOLDER_RE.lastIndex = 0;
        return part.replace(PLACEHOLDER_RE, '(?<$1>[^.]+)');
      }
      return escapeRegex(part);
    })
    .join('\\.');

  const hostPattern = new RegExp(`^${regexSource}$`);

  // Extract scope keys (named groups)
  const scopeKeys: string[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(host)) !== null) {
    scopeKeys.push(m[1]);
  }

  return { anchor, hostPattern, scopeKeys };
}

/** Build a path regex from a URL path string. */
export function buildPathPattern(urlPath: string, prefixMatch: boolean): RegExp {
  // Replace placeholders with [^/]+ for matching
  PLACEHOLDER_RE.lastIndex = 0;
  const regexSource = urlPath
    .split('/')
    .map((seg) => {
      PLACEHOLDER_RE.lastIndex = 0;
      if (PLACEHOLDER_RE.test(seg)) return '[^/]+';
      return escapeRegex(seg);
    })
    .join('/');

  if (prefixMatch) {
    return new RegExp(`^${regexSource}`);
  }
  return new RegExp(`^${regexSource}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Discovery file → OAuthProvider
// ---------------------------------------------------------------------------

export interface DiscoveryFile {
  [key: string]: unknown;
  token_endpoint?: string;
  authorization_endpoint?: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  api_base_url?: string;
  _api_hosts?: string[];
  _token_format?: {
    prefixLen?: number;
    suffixLen?: number;
    delimiters?: string;
  };
  _host_patterns?: string[];
}

/**
 * Parse a single discovery file into an OAuthProvider.
 * Returns null if the file should be skipped (no usable endpoints).
 */
export function parseDiscoveryFile(
  id: string,
  data: DiscoveryFile,
): OAuthProvider | null {
  // Must have at least token_endpoint or authorization_endpoint
  if (!data.token_endpoint && !data.authorization_endpoint) {
    logger.debug({ id }, 'Discovery: skipping file (no token or authorization endpoint)');
    return null;
  }

  const rules: InterceptRule[] = [];
  const allScopeKeys = new Set<string>();

  // Track which hosts we've seen to generate catch-all bearer-swap rules
  const hostsWithEndpoints = new Set<string>();
  const hostsWithBearerSwap = new Set<string>();

  // Process each endpoint field
  for (const def of ENDPOINT_FIELDS) {
    const url = data[def.field] as string | undefined;
    if (!url || typeof url !== 'string') continue;

    const parsed = parseEndpointUrl(url);
    if (!parsed) {
      logger.debug({ id, field: def.field, url }, 'Discovery: could not parse URL');
      continue;
    }

    const hostMatch = buildHostMatch(parsed.host);
    if (!hostMatch) {
      logger.debug({ id, host: parsed.host }, 'Discovery: skipping fully-templated host');
      continue;
    }

    hostsWithEndpoints.add(parsed.host);
    if (def.mode === 'bearer-swap') {
      hostsWithBearerSwap.add(parsed.host);
    }

    for (const key of hostMatch.scopeKeys) {
      allScopeKeys.add(key);
    }

    rules.push({
      anchor: hostMatch.anchor,
      hostPattern: hostMatch.hostPattern,
      pathPattern: buildPathPattern(parsed.path, def.prefixMatch ?? false),
      mode: def.mode,
    });
  }

  // Process _api_hosts for additional bearer-swap hosts
  if (data._api_hosts) {
    for (const apiHost of data._api_hosts) {
      const hostMatch = buildHostMatch(apiHost);
      if (!hostMatch) continue;
      for (const key of hostMatch.scopeKeys) {
        allScopeKeys.add(key);
      }
      rules.push({
        anchor: hostMatch.anchor,
        hostPattern: hostMatch.hostPattern,
        pathPattern: /^\//,
        mode: 'bearer-swap',
      });
      hostsWithBearerSwap.add(apiHost);
    }
  }

  // Generate catch-all bearer-swap for endpoint hosts that don't have
  // an explicit bearer-swap rule and no api_base_url was provided.
  // This handles the case where e.g. userinfo_endpoint's host also serves API requests.
  if (!data.api_base_url && !data._api_hosts) {
    for (const host of hostsWithEndpoints) {
      if (hostsWithBearerSwap.has(host)) continue;
      const hostMatch = buildHostMatch(host);
      if (!hostMatch) continue;
      rules.push({
        anchor: hostMatch.anchor,
        hostPattern: hostMatch.hostPattern,
        pathPattern: /^\//,
        mode: 'bearer-swap',
      });
    }
  }

  if (rules.length === 0) {
    logger.debug({ id }, 'Discovery: no usable rules produced');
    return null;
  }

  // Build substitute config from _token_format or use defaults
  let substituteConfig: SubstituteConfig = DEFAULT_SUBSTITUTE_CONFIG;
  if (data._token_format) {
    substituteConfig = {
      prefixLen: data._token_format.prefixLen ?? DEFAULT_SUBSTITUTE_CONFIG.prefixLen,
      suffixLen: data._token_format.suffixLen ?? DEFAULT_SUBSTITUTE_CONFIG.suffixLen,
      delimiters: data._token_format.delimiters ?? DEFAULT_SUBSTITUTE_CONFIG.delimiters,
    };
  }

  return {
    id,
    rules,
    scopeKeys: [...allScopeKeys],
    substituteConfig,
  };
}

// ---------------------------------------------------------------------------
// Load all discovery files from a directory
// ---------------------------------------------------------------------------

/**
 * Load all discovery files from the given directory.
 * Returns a Map<providerId, OAuthProvider>.
 */
export function loadDiscoveryProviders(
  discoveryDir: string,
): Map<string, OAuthProvider> {
  const providers = new Map<string, OAuthProvider>();

  let files: string[];
  try {
    files = fs.readdirSync(discoveryDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    logger.warn({ err, discoveryDir }, 'Discovery: could not read directory');
    return providers;
  }

  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    try {
      const content = fs.readFileSync(path.join(discoveryDir, file), 'utf-8');
      const data = JSON.parse(content) as DiscoveryFile;
      const provider = parseDiscoveryFile(id, data);
      if (provider) {
        providers.set(id, provider);
      }
    } catch (err) {
      logger.warn({ err, file }, 'Discovery: could not parse file');
    }
  }

  logger.info(
    { count: providers.size, total: files.length },
    'Discovery: loaded OAuth providers',
  );

  return providers;
}
