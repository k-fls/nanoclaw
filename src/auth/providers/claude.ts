/**
 * Unified Claude CLI credential provider.
 *
 * Handles all auth methods for the Claude CLI binary:
 * 1. api_key     — paste Anthropic API key directly
 * 2. setup_token — long-lived OAuth token via `claude setup-token`
 * 3. auth_login  — OAuth login via `claude auth login`, stores entire .credentials.json
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { decrypt, encrypt, loadCredential } from '../store.js';
import { readKeysFile, writeKeysFile } from '../token-substitute.js';
import { asCredentialScope, asGroupScope } from '../oauth-types.js';
import { scopeOf } from '../../types.js';
import type { CredentialScope, GroupScope } from '../oauth-types.js';
import { authSessionDir, scopeClaudeDir } from '../exec.js';
import {
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  isGpgAvailable,
  isPgpMessage,
} from '../gpg.js';
import { IDLE_TIMEOUT } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import { proxyPipe, getProxy } from '../../credential-proxy.js';
import {
  RESELECT,
  type AuthContext,
  type AuthExecOpts,
  type AuthOption,
  type ChatIO,
  type CredentialProvider,
  type ExecHandle,
  type FlowResult,
} from '../types.js';

/** Substitute tokens injected into containers — never real credentials. */
export const PLACEHOLDER_API_KEY = 'sk-ant-api00-placeholder-nanoclaw';
export const PLACEHOLDER_ACCESS_TOKEN = 'sk-ant-oat01-placeholder-nanoclaw';
export const PLACEHOLDER_REFRESH_TOKEN = 'sk-ant-ort01-placeholder-nanoclaw';

/**
 * Default authFields for Claude OAuth tokens stored outside the proxy path
 * (migration, env import). The refresh endpoint requires client_id; scope is
 * included so proactive refresh builds a correct request body.
 *
 * Values sourced from Claude CLI OAuth packet capture (docs/claude-oauth-packet-capture.md).
 * The scope matches what captureAuthFields + scopeInclude would produce.
 */
export const CLAUDE_DEFAULT_AUTH_FIELDS: Record<string, string> = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scope:
    'user:inference user:mcp_servers user:profile user:sessions:claude_code user:file_upload',
};

export interface AuthErrorInfo {
  /** HTTP status code (401, 403) extracted from the API error. */
  code: number;
  message: string;
}

/**
 * Strict matcher for Claude SDK auth errors.
 * Expected format:
 *   Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_..."}
 */
const API_ERROR_RE =
  /^Failed to authenticate\. API Error:\s*(\d{3})\s*(\{.*\})$/;

/** HTTP status codes that mean credentials should be replaced. */
const AUTH_STATUS_CODES = new Set([401, 403]);

function parseApiError(error: string): AuthErrorInfo | null {
  const m = API_ERROR_RE.exec(error.trim());
  if (!m) return null;
  const code = parseInt(m[1], 10);
  if (!AUTH_STATUS_CODES.has(code)) return null;

  let body: any;
  try {
    body = JSON.parse(m[2]);
  } catch {
    return null; // JSON must be valid
  }

  if (body?.type !== 'error' || !body?.error?.type) return null;

  const message = body.error.message || `HTTP ${code}`;
  return { code, message };
}

/** Classify a container error. Returns null if not auth-related. */
export function classifyAuthError(error?: string): AuthErrorInfo | null {
  if (!error) return null;
  return parseApiError(error);
}

/** Check if a container error indicates credentials should be replaced. */
export function isAuthError(error?: string): boolean {
  return classifyAuthError(error) !== null;
}

/**
 * Extract request_id from a Claude API error in streaming output.
 * The error format is: Failed to authenticate. API Error: 401 {"...","request_id":"req_..."}
 */
export function extractStreamRequestId(error: string): string | null {
  const m = API_ERROR_RE.exec(error.trim());
  if (!m) return null;
  try {
    const body = JSON.parse(m[2]);
    return typeof body.request_id === 'string' ? body.request_id : null;
  } catch {
    return null;
  }
}

/**
 * Extract request_id from an upstream Anthropic API error response body.
 * The body is raw JSON: {"type":"error","error":{...},"request_id":"req_..."}
 */
export function extractUpstreamRequestId(responseBody: string): string | null {
  try {
    const body = JSON.parse(responseBody);
    return typeof body.request_id === 'string' ? body.request_id : null;
  } catch {
    return null;
  }
}

/** Check if a user reply is a cancel/decline. */
function isCancelReply(reply: string): boolean {
  const lower = reply.trim().toLowerCase();
  return ['cancel', 'abort', 'no', 'skip', 'quit', 'exit'].includes(lower);
}

/** .env keys this provider can import into the default scope. */
const ENV_FALLBACK_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
];

/** Claude CLI session dir mount — provider-specific. */
function claudeExecOpts(sessionDir: string): AuthExecOpts {
  return {
    mounts: [[sessionDir, '/home/node/.claude']],
  };
}

/** File the xdg-open shim writes inside the auth-ipc mount. */
const OAUTH_URL_FILE = '.oauth-url';

/**
 * Stdin paste prompt pattern.
 * With xdg-open returning 0 the CLI may not show a paste prompt at all
 * (e.g. auth-login). setup-token may still fall back to it.
 */
const DEFAULT_PASTE_PROMPT_RE = /Paste\s+code\s+here\s+.*prompted/;

/** How long to wait for the CLI to print the OAuth URL. */
const URL_WAIT_MS = 60_000;

/** How long to wait for the code delivery mechanism to become available. */
const DELIVERY_DETECT_MS = 30_000;

export interface CodeDeliveryHandler {
  /** OAuth URL to show the user. */
  oauthUrl: string;
  /** User-facing instructions for completing the auth flow. */
  instructions: string;
  /** Deliver the user's response (code or redirect URL) to the CLI. */
  deliver(userInput: string): Promise<{ done: boolean; response?: string }>;
}

/** ANSI escape sequence pattern. */
const ANSI_RE_G = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Strip ANSI escapes and control characters from PTY output. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE_G, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/**
 * Check if a TCP port is open on a given host.
 * Returns true if a connection is established within timeoutMs.
 */
export function isPortOpen(
  port: number,
  timeoutMs: number,
  host: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Parse a localhost callback URL to extract code, state, and port.
 * Accepts URLs like: http://localhost:54321/callback?code=abc&state=xyz
 * Returns the port so callers can verify it matches the expected callback port.
 */
export function parseCallbackUrl(
  input: string,
): { code: string; state: string; port: number } | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const port = url.port ? parseInt(url.port, 10) : null;
    if (code && state && port) return { code, state, port };
  } catch {
    /* not a valid URL */
  }
  return null;
}

/**
 * Poll accumulating output for a regex match.
 * PTY is set to 500 columns so nothing wraps — simple regex is sufficient.
 */
export function waitForPattern(
  outputRef: { value: string },
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray | null> {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      const clean = stripAnsi(outputRef.value);
      const match = clean.match(pattern);
      if (match) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(match);
      }
    }, 500);
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve(null);
    }, timeoutMs);
  });
}

/** Race waitForPattern against the process exiting. */
function waitForPatternOrExit(
  outputRef: { value: string },
  pattern: RegExp,
  timeoutMs: number,
  handle: ExecHandle,
): Promise<RegExpMatchArray | null> {
  return Promise.race([
    waitForPattern(outputRef, pattern, timeoutMs),
    handle.wait().then(() => null),
  ]);
}

/** OAuth URL pattern for Anthropic/Claude domains. */
const OAUTH_URL_RE =
  /https:\/\/(?:console\.anthropic\.com|claude\.ai|platform\.claude\.com|claude\.com\/cai\/oauth)\S+/;

/**
 * Detect how the CLI is ready to receive the auth code and return a handler.
 *
 * Races two signals in parallel:
 *   (a) stdout matches pastePrompt pattern → stdin handler
 *   (b) shim wrote .oauth-url with localhost callback URL → callback handler
 *
 * @param stdoutOauthUrl  OAuth URL already matched from stdout (used for stdin handler).
 * @param pastePrompt     Pattern to detect stdin readiness. Pass null to
 *                        disable stdin detection (e.g. for auth-login).
 */
export function detectCodeDelivery(
  outputRef: { value: string },
  authIpcDir: string,
  timeoutMs: number,
  handle: ExecHandle,
  stdoutOauthUrl: string,
  containerIP: string,
  pastePrompt: RegExp | null = DEFAULT_PASTE_PROMPT_RE,
): Promise<CodeDeliveryHandler | null> {
  const oauthUrlPath = path.join(authIpcDir, OAUTH_URL_FILE);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: CodeDeliveryHandler | null) => {
      if (resolved) return;
      resolved = true;
      clearInterval(check);
      clearTimeout(timer);
      resolve(result);
    };

    const check = setInterval(() => {
      // Check stdout for paste prompt (only if pattern provided)
      if (pastePrompt && pastePrompt.test(stripAnsi(outputRef.value))) {
        done(stdinHandler(stdoutOauthUrl, handle));
        return;
      }
      // Check for shim-written URL file (callback path)
      try {
        const url = fs.readFileSync(oauthUrlPath, 'utf-8').trim();
        if (url) {
          const portMatch = url.match(
            /redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/,
          );
          if (portMatch) {
            const port = parseInt(portMatch[1], 10);
            isPortOpen(port, 5000, containerIP).then((open) => {
              done(open ? callbackHandler(url, containerIP, port) : null);
            });
          } else {
            done(null);
          }
          return;
        }
      } catch {
        /* not yet */
      }
    }, 500);

    const timer = setTimeout(() => done(null), timeoutMs);
    handle.wait().then(() => done(null));
  });
}

function stdinHandler(
  oauthUrl: string,
  handle: ExecHandle,
): CodeDeliveryHandler {
  return {
    oauthUrl,
    instructions:
      'After authorizing, the website will display a code. ' +
      'Copy and paste that code here (or reply "cancel" to abort):',
    async deliver(userInput: string) {
      // If the user pasted a callback URL instead of a raw code, extract
      // code#state from it so it still works.
      const fromUrl = parseCallbackUrl(userInput);
      const code = fromUrl
        ? `${fromUrl.code}#${fromUrl.state}`
        : userInput.trim();

      // Ink processes keystrokes asynchronously. Write the code first,
      // wait for Ink to process it, then send \r (Enter) separately.
      handle.stdin.write(code);
      await new Promise((r) => setTimeout(r, 200));
      handle.stdin.write('\r');
      return { done: true };
    },
  };
}

/**
 * Build a CodeDeliveryHandler that validates user input as a callback URL
 * and delivers the code+state to a localhost callback port.
 *
 * @param host  Target host for the callback (localhost for reauth, container bridge IP for flow queue).
 * @param port  Expected callback port — mismatches are rejected so the user can retry.
 * @param cbPath  Callback path (default: /callback).
 */
export function callbackHandler(
  oauthUrl: string,
  host: string,
  port: number,
  cbPath = '/callback',
): CodeDeliveryHandler {
  return {
    oauthUrl,
    instructions:
      'After authorizing, your browser will redirect to a localhost URL.\n\n' +
      '‼️ *The page will show an error* ("connection refused", "unable to connect", or similar) — ' +
      'this is expected! Do NOT close the tab.\n\n' +
      "Copy the full URL from your browser's *address bar* (it will look like " +
      `\`http://localhost:${port}${cbPath}?code=...\`) ` +
      'and paste it here (or reply "cancel" to abort):',
    async deliver(userInput: string) {
      const parsed = parseCallbackUrl(userInput);
      if (!parsed) {
        return {
          done: false,
          response:
            'Could not parse the URL. Expected a URL like http://localhost:PORT/callback?code=...&state=...',
        };
      }
      if (parsed.port !== port) {
        return {
          done: false,
          response: `Port mismatch: URL has port ${parsed.port} but expected ${port}. Make sure you copied the correct URL.`,
        };
      }
      const callbackUrl = `http://${host}:${port}${cbPath}?code=${encodeURIComponent(parsed.code)}&state=${encodeURIComponent(parsed.state)}`;
      try {
        const res = await fetch(callbackUrl, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          return { done: true };
        }
        return { done: false, response: `Callback returned ${res.status}` };
      } catch (err) {
        logger.warn({ callbackUrl, err }, 'Callback delivery failed');
        return {
          done: true,
          response: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/** Parse .credentials.json content to extract tokens and expiry. */
function parseCredentialsJson(json: string): {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
} | null {
  try {
    const data = JSON.parse(json);
    // credentials.json may have token at top level or nested under claudeAiOauth
    const creds = data.claudeAiOauth ?? data;
    if (creds.accessToken) {
      // CLI stores expiresAt as epoch ms (number); normalize to ISO string
      let expiresAt: string | null = null;
      if (typeof creds.expiresAt === 'number') {
        expiresAt = new Date(creds.expiresAt).toISOString();
      } else if (typeof creds.expiresAt === 'string') {
        expiresAt = creds.expiresAt;
      }
      return {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if an expires_at timestamp is still valid (with 5 min buffer). */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  return Date.now() > expiry - 5 * 60 * 1000;
}

/**
 * Race chat.receive() against the auth container exiting.
 * The container has a hard timeout (DEFAULT_AUTH_TIMEOUT_MS in exec.ts)
 * so if the user walks away, the container is killed and the group's
 * slot is released. No separate hardcoded timeout needed here.
 */
function receiveOrContainerExit(
  chat: ChatIO,
  handle: ExecHandle,
): Promise<string | null> {
  return Promise.race([
    chat.receive(IDLE_TIMEOUT - 30_000), // expire before container kill so we can notify user
    handle.wait().then(() => null),
  ]);
}

/**
 * Shared OAuth flow for setup-token and auth-login.
 * Handles container spawn, URL detection, code delivery, and user interaction.
 * Returns the handle + output ref on success so callers can extract results.
 */
async function runOAuthFlow(
  ctx: AuthContext,
  flowName: string,
  cliCommand: string,
  pastePrompt: RegExp | null = DEFAULT_PASTE_PROMPT_RE,
): Promise<{
  handle: ExecHandle;
  output: { value: string };
  sessionDir: string;
} | null> {
  await ctx.chat.send(
    `Starting Claude ${flowName} flow. Spawning container...`,
  );

  const sessionDir = authSessionDir(ctx.scope);
  const authIpcDir = path.join(sessionDir, 'auth-ipc');
  // Remove stale .oauth-url from previous attempts before container starts
  try {
    fs.unlinkSync(path.join(authIpcDir, OAUTH_URL_FILE));
  } catch {
    /* ignore */
  }
  const { handle, containerIP } = ctx.startExec(
    // Wide PTY so Ink doesn't wrap long URLs/tokens (\r overwrites corrupt them)
    ['script', '-qc', `stty columns 500 && ${cliCommand}`, '/dev/null'],
    claudeExecOpts(sessionDir),
  );

  const output = { value: '' };
  handle.onStdout((chunk) => {
    output.value += chunk;
  });

  // Wait for the OAuth URL in stdout
  const urlMatch = await waitForPatternOrExit(
    output,
    OAUTH_URL_RE,
    URL_WAIT_MS,
    handle,
  );
  if (!urlMatch) {
    await ctx.chat.send(
      'Container exited or timed out before providing OAuth URL.',
    );
    handle.kill();
    return null;
  }

  // Detect how the CLI will accept the code
  const delivery = await detectCodeDelivery(
    output,
    authIpcDir,
    DELIVERY_DETECT_MS,
    handle,
    urlMatch[0],
    containerIP,
    pastePrompt,
  );
  if (!delivery) {
    await ctx.chat.send(
      'Could not detect auth input method. Container may have exited.',
    );
    handle.kill();
    return null;
  }

  await ctx.chat.send(
    `Open this URL and authorize:\n${delivery.oauthUrl}\n\n${delivery.instructions}`,
  );

  const userInput = await receiveOrContainerExit(ctx.chat, handle);
  if (!userInput || isCancelReply(userInput)) {
    await ctx.chat.send(
      userInput ? 'Cancelled.' : 'Auth container exited or timed out.',
    );
    handle.kill();
    return null;
  }

  const delivered = await delivery.deliver(userInput);
  if (!delivered.done) {
    await ctx.chat.send(
      `Failed to deliver auth code. ${delivered.response ?? ''}`,
    );
    handle.kill();
    return null;
  }

  return { handle, output, sessionDir };
}

// ── Migration: claude_auth.json → claude.keys.json ──────────────────

/** Provider ID used as the keys file name and engine key. */
export const PROVIDER_ID = 'claude';

/**
 * If claude.keys.json doesn't exist for a scope but claude_auth.json does,
 * extract the access/refresh tokens and write them to claude.keys.json.
 * Called once at startup per scope.
 */
export function migrateClaudeCredentials(scope: string): void {
  const credScope = asCredentialScope(scope);
  // Already migrated?
  const existing = readKeysFile(credScope, PROVIDER_ID);
  if (Object.keys(existing).length > 0) return;

  const cred = loadCredential(scope, 'claude_auth');
  if (!cred) return;

  const plaintext = decrypt(cred.token);

  switch (cred.auth_type) {
    case 'api_key':
      writeKeysFile(credScope, PROVIDER_ID, {
        api_key: {
          value: encrypt(plaintext),
          updated_ts: Date.now(),
          expires_ts: 0,
        },
      });
      break;

    case 'setup_token':
      writeKeysFile(credScope, PROVIDER_ID, {
        access: {
          value: encrypt(plaintext),
          updated_ts: Date.now(),
          expires_ts: 0,
        },
      });
      break;

    case 'auth_login': {
      const parsed = parseCredentialsJson(plaintext);
      if (!parsed) return;
      const keys: Record<
        string,
        {
          value: string;
          updated_ts: number;
          expires_ts: number;
          authFields?: Record<string, string>;
        }
      > = {
        access: {
          value: encrypt(parsed.accessToken),
          updated_ts: Date.now(),
          expires_ts: parsed.expiresAt
            ? new Date(parsed.expiresAt).getTime()
            : 0,
          authFields: CLAUDE_DEFAULT_AUTH_FIELDS,
        },
      };
      if (parsed.refreshToken) {
        keys.refresh = {
          value: encrypt(parsed.refreshToken),
          updated_ts: Date.now(),
          expires_ts: 0,
          authFields: CLAUDE_DEFAULT_AUTH_FIELDS,
        };
      }
      writeKeysFile(credScope, PROVIDER_ID, keys);
      break;
    }
  }

  logger.info(
    { scope, authType: cred.auth_type },
    'Migrated claude_auth.json → claude.keys.json',
  );
}

// ── Host handlers ────────────────────────────────────────────────────

/**
 * Claude's OAuthProvider definition for the universal handler system.
 * Registered programmatically (not via discovery file) because Claude
 * has provider-specific logic: x-api-key mode, credential store integration.
 */

export const CLAUDE_SUBSTITUTE_CONFIG = {
  prefixLen: 14,
  suffixLen: 0,
  delimiters: '-_',
};

export const CLAUDE_OAUTH_PROVIDER: import('../oauth-types.js').OAuthProvider =
  {
    id: PROVIDER_ID,
    rules: [
      // Token exchange at platform.claude.com
      {
        anchor: 'platform.claude.com',
        pathPattern: /^\/v1\/oauth\/token$/,
        mode: 'token-exchange' as const,
      },
      // Bearer-swap for API calls at api.anthropic.com
      {
        anchor: 'api.anthropic.com',
        pathPattern: /^\//,
        mode: 'bearer-swap' as const,
      },
      // Bearer-swap for platform.claude.com (non-token paths)
      {
        anchor: 'platform.claude.com',
        pathPattern: /^\//,
        mode: 'bearer-swap' as const,
      },
    ],
    scopeKeys: [],
    substituteConfig: CLAUDE_SUBSTITUTE_CONFIG,
    refreshStrategy: 'proactive',
    tokenFieldCapture: {
      scopeInclude: ['user:file_upload'],
    },
  };

/**
 * Register an additional API host for Claude from a base URL string.
 * Parses the URL, skips if it's the default host, and registers the
 * universal handler + x-api-key wrapper. Safe to call with invalid URLs.
 */
export function registerClaudeBaseUrl(
  baseUrl: string,
  tokenEngine: import('../token-substitute.js').TokenSubstituteEngine,
  createUniversalHandler: typeof import('../universal-oauth-handler.js').createHandler,
): void {
  try {
    const hostname = new URL(baseUrl).hostname;
    if (!hostname || hostname === 'api.anthropic.com') return;

    const proxy = getProxy();
    const rule = {
      anchor: hostname,
      pathPattern: /^\//,
      mode: 'bearer-swap' as const,
    };
    const handler = createUniversalHandler(
      CLAUDE_OAUTH_PROVIDER,
      rule,
      tokenEngine,
    );
    const hostPattern = new RegExp(`^${hostname.replace(/\./g, '\\.')}$`);
    proxy.registerAnchoredRule(
      hostname,
      hostPattern,
      rule.pathPattern,
      handler,
    );
  } catch {
    /* invalid URL, ignore */
  }
}

// ── Container credential provisioning ─────────────────────────────────

/**
 * True if the given credential scope has a Claude OAuth subscription token
 * (role = 'access'). Remote control requires a subscription — API keys won't work.
 */
export function hasSubscriptionCredential(scope: CredentialScope): boolean {
  const keys = readKeysFile(scope, PROVIDER_ID);
  return !!keys.access;
}

// ── Provider ────────────────────────────────────────────────────────

export const claudeProvider: CredentialProvider = {
  id: PROVIDER_ID,
  displayName: 'Claude',

  importEnv(
    scope: CredentialScope,
    resolver: import('../oauth-types.js').TokenResolver,
  ): void {
    const envVars = readEnvFile(ENV_FALLBACK_KEYS);
    if (Object.keys(envVars).length === 0) return;

    const credScope = scope;

    // API key takes priority over OAuth tokens (mode exclusivity)
    if (envVars.ANTHROPIC_API_KEY) {
      resolver.store(
        envVars.ANTHROPIC_API_KEY,
        PROVIDER_ID,
        credScope,
        'api_key',
      );
    } else {
      if (envVars.CLAUDE_CODE_OAUTH_TOKEN) {
        resolver.store(
          envVars.CLAUDE_CODE_OAUTH_TOKEN,
          PROVIDER_ID,
          credScope,
          'access',
          0,
          CLAUDE_DEFAULT_AUTH_FIELDS,
        );
      }
      // ANTHROPIC_AUTH_TOKEN is a fallback for access token
      if (!envVars.CLAUDE_CODE_OAUTH_TOKEN && envVars.ANTHROPIC_AUTH_TOKEN) {
        resolver.store(
          envVars.ANTHROPIC_AUTH_TOKEN,
          PROVIDER_ID,
          credScope,
          'access',
          0,
          CLAUDE_DEFAULT_AUTH_FIELDS,
        );
      }
    }

    logger.info(
      { scope, keys: Object.keys(envVars) },
      'Imported .env credentials into credential store',
    );
  },

  provision(
    group: import('../../types.js').RegisteredGroup,
    tokenEngine: import('../token-substitute.js').TokenSubstituteEngine,
  ): { env: Record<string, string> } {
    const scope = scopeOf(group);
    const env: Record<string, string> = {};

    // API key mode
    const subApiKey = tokenEngine.getOrCreateSubstitute(
      PROVIDER_ID,
      {},
      scope,
      CLAUDE_SUBSTITUTE_CONFIG,
      'api_key',
    );
    if (subApiKey) {
      env.ANTHROPIC_API_KEY = subApiKey;
      return { env };
    }

    // OAuth mode
    const subAccess = tokenEngine.getOrCreateSubstitute(
      PROVIDER_ID,
      {},
      scope,
      CLAUDE_SUBSTITUTE_CONFIG,
      'access',
    );
    if (!subAccess) return { env };

    env.CLAUDE_CODE_OAUTH_TOKEN = subAccess;
    const subRefresh = tokenEngine.getOrCreateSubstitute(
      PROVIDER_ID,
      {},
      scope,
      CLAUDE_SUBSTITUTE_CONFIG,
      'refresh',
    );

    // Write .credentials.json with substitute tokens + real expiresAt
    // Engine resolves the source scope (own or borrowed from default)
    const expiresAt = tokenEngine.getKeyExpiry(scope, PROVIDER_ID, 'access');
    const credentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: subAccess,
        refreshToken: subRefresh ?? subAccess,
        expiresAt,
      },
    });
    const credsPath = scopeClaudeDir(scope, '.credentials.json');
    fs.mkdirSync(path.dirname(credsPath), { recursive: true });
    fs.writeFileSync(credsPath, credentialsJson);

    return { env };
  },

  storeResult(
    scope: CredentialScope,
    result: FlowResult,
    tokenEngine: import('../token-substitute.js').TokenSubstituteEngine,
  ): void {
    const credScope = scope;
    const resolver = tokenEngine.getResolver();
    const groupScope = asGroupScope(scope);

    switch (result.auth_type) {
      case 'api_key':
        tokenEngine.clearCredentials(groupScope, PROVIDER_ID);
        resolver.store(result.token, PROVIDER_ID, credScope, 'api_key');
        break;
      case 'setup_token':
        tokenEngine.clearCredentials(groupScope, PROVIDER_ID);
        resolver.store(result.token, PROVIDER_ID, credScope, 'access');
        break;
      case 'auth_login': {
        const parsed = parseCredentialsJson(result.token);
        if (!parsed)
          throw new Error('Invalid .credentials.json in auth_login result');

        // The auth container runs through the credential proxy, so the tokens
        // in .credentials.json are substitutes (the proxy replaced real tokens
        // in the exchange response). Verify they resolve — this confirms the
        // proxy captured authFields alongside the real tokens.
        const accessResolved = tokenEngine.resolveSubstitute(
          parsed.accessToken,
          groupScope,
        );
        if (!accessResolved) {
          throw new Error(
            'Auth flow token exchange did not go through credential proxy — ' +
              'access token is not a known substitute. authFields were not captured.',
          );
        }
        if (parsed.refreshToken) {
          const refreshResolved = tokenEngine.resolveSubstitute(
            parsed.refreshToken,
            groupScope,
          );
          if (!refreshResolved) {
            throw new Error(
              'Auth flow token exchange did not go through credential proxy — ' +
                'refresh token is not a known substitute. authFields were not captured.',
            );
          }
        }
        // Proxy already stored real tokens with authFields via generateSubstitute.
        // No clearCredentials — would destroy the proxy-stored tokens.
        break;
      }
      default:
        throw new Error(`Unknown auth_type: ${result.auth_type}`);
    }

    tokenEngine.pruneStaleRefs(groupScope, PROVIDER_ID);
  },

  authOptions(scope: CredentialScope): AuthOption[] {
    return [
      // --- Setup token (long-lived, requires browser) ---
      {
        label: 'Setup token (requires Claude subscription)',
        description:
          'Generates a long-lived OAuth token via `claude setup-token`. Token is valid for ~1 year.',
        provider: this,
        credentialScope: scope,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          const handle = await runOAuthFlow(
            ctx,
            'setup token',
            'claude setup-token',
          );
          if (!handle) return null;

          const result = await handle.handle.wait();
          const allOutput = stripAnsi(handle.output.value + result.stdout);

          const tokenMatch = allOutput.match(/sk-ant-\S+/);
          if (!tokenMatch) {
            await ctx.chat.send(
              'Failed to extract setup token from output. Check logs.',
            );
            logger.error(
              { stdout: allOutput, stderr: result.stderr },
              'Setup token extraction failed',
            );
            return null;
          }

          await ctx.chat.send('Setup token obtained successfully.');
          return {
            auth_type: 'setup_token',
            token: tokenMatch[0],
            expires_at: null,
          };
        },
      },

      // --- Auth login (auto-refreshes, requires browser) ---
      {
        label: 'Auth login (requires Claude subscription)',
        description:
          'Standard OAuth login via `claude auth login`. Does not expose long-term refresh key to agent. Access keys are refreshed automatically.',
        provider: this,
        credentialScope: scope,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          // auth-login with xdg-open returning 0 won't show a paste prompt,
          // so disable stdin detection (null pastePrompt) — callback only.
          const handle = await runOAuthFlow(
            ctx,
            'auth login',
            'claude auth login',
            null,
          );
          if (!handle) return null;

          await handle.handle.wait();

          // Read .credentials.json from the session dir mount
          const credsPath = path.join(handle.sessionDir, '.credentials.json');

          let credsContent: string | null = null;
          try {
            credsContent = fs.readFileSync(credsPath, 'utf-8');
          } catch {
            // not found
          }

          if (!credsContent) {
            await ctx.chat.send(
              'Failed to read .credentials.json from container. Check logs.',
            );
            logger.error(
              { credsPath },
              'Auth login: .credentials.json not found',
            );
            return null;
          }

          const parsed = parseCredentialsJson(credsContent);
          if (!parsed) {
            await ctx.chat.send('Invalid .credentials.json content.');
            return null;
          }

          await ctx.chat.send('Auth login completed successfully.');
          return {
            auth_type: 'auth_login',
            token: credsContent,
            expires_at: parsed.expiresAt,
          };
        },
      },

      // --- API key (GPG-encrypted only) ---
      {
        label: 'API key (GPG-encryption required)',
        description:
          'Requires use of a GPG tool to pass the key in chat safely.',
        provider: this,
        credentialScope: scope,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          if (!isGpgAvailable()) {
            await ctx.chat.send(
              'GPG is not installed on the server. ' +
                'Install it (`apt install gnupg` or `brew install gnupg`) and try again.\n\n' +
                'Returning to auth method selection...',
            );
            return RESELECT;
          }

          let pubKey: string;
          try {
            ensureGpgKey(ctx.scope);
            pubKey = exportPublicKey(ctx.scope);
          } catch (err) {
            logger.warn({ err }, 'GPG key setup failed');
            await ctx.chat.send(
              'Failed to initialize GPG keypair: ' +
                `${err instanceof Error ? err.message : String(err)}\n\n` +
                'Returning to auth method selection...',
            );
            return RESELECT;
          }

          // Send public key without prefix so it's directly copy-pasteable
          await ctx.chat.sendRaw(pubKey);

          await ctx.chat.send(
            'Paste a GPG-encrypted Anthropic API key.\n\n' +
              '*Step 1.* Import the public key above.\n\n' +
              'With local GPG:\n' +
              '```\n' +
              "gpg --import <<'EOF'\n" +
              '... (paste the key) ...\n' +
              'EOF\n' +
              '```\n\n' +
              '*Step 2.* Encrypt your API key:\n' +
              '```\n' +
              'echo "sk-ant-api..." | gpg --encrypt --armor --recipient nanoclaw\n' +
              '```\n\n' +
              "If you don't have GPG installed locally, you can use an online PGP tool " +
              '(import the public key, encrypt your API key, copy the armored output):\n' +
              '• https://www.devglan.com/online-tools/pgp-encryption-decryption\n' +
              '• https://keychainpgp.github.io/\n' +
              '⚠️ Online tools see your key in plaintext — use only if you trust the site.\n\n' +
              '*Step 3.* Paste the encrypted output here. Reply "cancel" to abort.',
          );

          const reply = await ctx.chat.receive(IDLE_TIMEOUT - 30_000);
          if (!reply || isCancelReply(reply)) return null;

          if (!isPgpMessage(reply)) {
            await ctx.chat.send(
              'Expected a GPG-encrypted message (-----BEGIN PGP MESSAGE-----).\n' +
                'Plaintext keys are not accepted for security reasons.\n\n' +
                'Returning to auth method selection...',
            );
            return RESELECT;
          }

          let apiKey: string;
          try {
            apiKey = gpgDecrypt(ctx.scope, reply.trim());
          } catch (err) {
            await ctx.chat.send(
              'Failed to decrypt PGP message. Make sure you encrypted with the public key shown above.',
            );
            logger.error({ scope: ctx.scope, err }, 'GPG decrypt failed');
            return null;
          }

          if (!apiKey.startsWith('sk-ant-api')) {
            await ctx.chat.send(
              'Invalid key format — expected sk-ant-api prefix after decryption.',
            );
            return null;
          }

          return { auth_type: 'api_key', token: apiKey, expires_at: null };
        },
      },
    ];
  },
};
