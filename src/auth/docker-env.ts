/**
 * Docker -e env var names — compile-time enforced.
 *
 * Separated from container-args.ts to avoid circular imports
 * (container-args → credential-proxy → substitute-endpoint → here).
 */
import fs from 'fs';
import path from 'path';

/**
 * All env var names injected via Docker `-e` flags.
 * Adding a new `-e` var requires adding it here — `pushEnv()` enforces the type.
 * The substitute endpoint imports this to block `get_credential` from overwriting them.
 */
export const DOCKER_ENV_NAMES = [
  // Proxy infra (applyTransparentProxyArgs)
  'PROXY_HOST',
  'PROXY_PORT',
  'NODE_EXTRA_CA_CERTS',
  'HOST_UID',
  'HOST_GID',
  'HOME',
  // Timezone (container-runner.ts)
  'TZ',
  // Claude credentials (provision)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Bash env sourcing for ~/.env-vars
  'BASH_ENV',
] as const;

export type DockerEnvName = typeof DOCKER_ENV_NAMES[number];

/** Type-safe Docker `-e` push. Only names in DOCKER_ENV_NAMES are accepted. */
export function pushEnv(args: string[], key: DockerEnvName, value: string): void {
  args.push('-e', `${key}=${value}`);
}

// ── Env var name validation ───────────────────────────────────────

/** Format: uppercase letters, digits, underscores. Must start with letter or underscore. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Dangerous Linux/bash/Node vars that aren't in DOCKER_ENV_NAMES but must never be overwritten. */
export const DANGEROUS_ENV_NAMES = new Set([
  'PATH', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'TERM',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'IFS', 'CDPATH', 'ENV',
  'NODE_OPTIONS',
]);

/** Combined deny-set: Docker-injected + dangerous system vars. */
export const RESERVED_ENV_NAMES = new Set([
  ...DOCKER_ENV_NAMES,
  ...DANGEROUS_ENV_NAMES,
]);

/** Returns error message if name is invalid, null if valid. */
export function validateEnvVarName(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) {
    return `Invalid env var name format: '${name}' (must match ${ENV_NAME_RE})`;
  }
  if (RESERVED_ENV_NAMES.has(name)) {
    return `Reserved env var name: '${name}'`;
  }
  return null;
}

// ── env-custom.jsonl parsing ──────────────────────────────────────

/**
 * Parse env-custom.jsonl content into curated env vars.
 *
 * Each line must be a JSON object with `name` (string) and `value` (string).
 * Parsing stops at the first unparsable line — everything after is discarded.
 * Last-write-wins for duplicate names.
 *
 * Curation:
 *   - Names failing format or reserved checks are excluded
 *   - Names already in `claimed` (credential env vars) are excluded
 *
 * @returns Curated map of envName → value
 */
/**
 * Build ~/.env-vars from credential env vars + curated agent custom env vars.
 *
 * @param credentialEnvVars — env vars from credential substitutes (discovery providers)
 * @param groupDir — host-side group folder path (contains env-custom.jsonl)
 * @param destPath — path to write ~/.env-vars to
 */
export function writeEnvVarsFile(
  credentialEnvVars: Record<string, string>,
  refsEnvVars: Record<string, string>,
  groupDir: string,
  destPath: string,
): void {
  const lines: string[] = [];

  // 1. Credential substitute env vars (static provider envVars — highest precedence)
  const claimedNames = new Set(Object.keys(credentialEnvVars));
  for (const [k, v] of Object.entries(credentialEnvVars)) {
    lines.push(`export ${k}=${v}`);
  }

  // 2. Refs-based env vars (import-registered substitutes)
  for (const [k, v] of Object.entries(refsEnvVars)) {
    if (claimedNames.has(k)) continue;
    claimedNames.add(k);
    lines.push(`export ${k}=${v}`);
  }

  // 3. Agent-written custom env vars (curated: reserved/invalid/overridden excluded)
  try {
    const customContent = fs.readFileSync(path.join(groupDir, 'env-custom.jsonl'), 'utf-8');
    const customVars = parseEnvCustomJsonl(customContent, claimedNames);
    for (const [k, v] of Object.entries(customVars)) {
      lines.push(`export ${k}=${v}`);
    }
  } catch {
    // File doesn't exist or unreadable — no custom vars
  }

  fs.writeFileSync(destPath, lines.length > 0 ? lines.join('\n') + '\n' : '');
}

export function parseEnvCustomJsonl(
  content: string,
  claimed: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break; // stop at first unparsable line
    }

    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof (parsed as any).name !== 'string' ||
      typeof (parsed as any).value !== 'string'
    ) {
      break; // malformed structure
    }

    const { name, value } = parsed as { name: string; value: string };

    if (validateEnvVarName(name) !== null) continue; // invalid or reserved
    if (claimed.has(name)) continue; // already set by credentials

    result[name] = value;
  }

  return result;
}
