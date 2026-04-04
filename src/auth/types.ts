/**
 * Per-group credential system — type definitions.
 */
import type { CredentialScope, GroupScope } from './oauth-types.js';
import type { ChatIO } from '../interaction/types.js';

/** On-disk credential file format at ~/.config/nanoclaw/credentials/{scope}/{service}.json */
export interface StoredCredential {
  auth_type: string;
  token: string; // encrypted: enc:<algo>:<keyHash16>:<iv>:<tag>:<ciphertext>, or plaintext
  expires_at: string | null;
  updated_at: string;
}

/** Re-export HostHandler so providers can reference it without importing credential-proxy directly. */
export type { HostHandler } from './credential-proxy.js';

/** Pluggable per-service credential provider. */
export interface CredentialProvider {
  /** Provider ID matching the keys file name: 'claude', etc. */
  id: string;
  displayName: string;

  /**
   * Host rules for transparent proxy routing.
   * @param host — matched against hostname at connection time (TLS termination).
   * @param pattern — matched against "host/path" at request time (handler selection).
   */
  hostRules?: Array<{
    hostPattern: RegExp;
    pathPattern: RegExp;
    handler: import('./credential-proxy.js').HostHandler;
  }>;

  /**
   * Produce substitute env vars for a container run.
   * Returns substitutes only — never real tokens. The engine resolves
   * credential source scopes internally using the group's flags.
   */
  provision(
    group: import('../types.js').RegisteredGroup,
    tokenEngine: import('./token-substitute.js').TokenSubstituteEngine,
  ): {
    env: Record<string, string>;
  };

  /** After flow completes, parse raw result and save via token engine. */
  storeResult(
    scope: CredentialScope,
    result: FlowResult,
    tokenEngine: import('./token-substitute.js').TokenSubstituteEngine,
  ): void;

  /** Auth options for the reauth menu. */
  authOptions(scope: CredentialScope): AuthOption[];

  /**
   * Import credentials from .env into the given scope.
   * Each provider reads its own keys from .env and writes to the resolver.
   * Called once at startup for the 'default' scope.
   */
  importEnv?(
    scope: CredentialScope,
    resolver: import('./oauth-types.js').TokenResolver,
  ): void;
}

/** A single auth method offered by a provider. */
export interface AuthOption {
  label: string;
  /** Extra explanatory text shown below the label in the menu. */
  description?: string;
  provider: CredentialProvider;
  /** Where credentials will be stored. Set by the caller of authOptions(). */
  credentialScope: CredentialScope;
  run(ctx: AuthContext): Promise<FlowResult | null>;
}

/** Options for exec() in auth context. */
export interface AuthExecOpts {
  /** Provider-specific bind mounts as [hostPath, containerPath, mode?] tuples. */
  mounts?: Array<[string, string, string?]>;
}

/** Result of spawning an auth container. */
export interface ExecContainerResult {
  handle: ExecHandle;
  /** Container's bridge IP for callback delivery to the CLI's OAuth server. */
  containerIP: string;
  /** Container name for docker exec. */
  containerName: string;
}

/** Context passed to auth option run(). */
export interface AuthContext {
  /** Where credentials are stored (group folder or 'default'). */
  scope: CredentialScope;
  /** Spawn a command inside a container. Returns handle + bridge IP for callback delivery. */
  startExec(command: string[], opts?: AuthExecOpts): ExecContainerResult;
  /** Send/receive messages to the user through normal routing. */
  chat: ChatIO;
}

/** Re-export ChatIO from the interaction module so auth consumers can import from one place. */
export type { ChatIO } from '../interaction/types.js';

/** Handle to a spawned container process. */
export interface ExecHandle {
  onStdout(cb: (chunk: string) => void): void;
  stdin: { write(data: string): void; end(): void };
  wait(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kill(): void;
}

/** Result from an auth flow, before encryption. */
export interface FlowResult {
  auth_type: string;
  token: string; // plaintext — store will encrypt
  expires_at?: string | null;
}

/**
 * Sentinel value returned by an auth option's run() to signal that the
 * reauth menu should be shown again (e.g. when a prerequisite is missing).
 */
export const RESELECT: FlowResult = Object.freeze({
  auth_type: '__reselect__',
  token: '',
});
