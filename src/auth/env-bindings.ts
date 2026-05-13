/**
 * Helpers for working with a provider's parsed env-var bindings.
 *
 * The discovery loader turns `_env_vars` JSON into `OAuthProvider.envBindings`,
 * an array of {@link EnvVarBinding}. Consumers (provisioning, import, listing,
 * substitute endpoint) call into this module instead of re-parsing the raw map.
 *
 * The slice syntax `"VAR": "credId[n]"` references the n-th field of a composite
 * credential whose fields are joined by the credential's declared `sep`.
 */
import type {
  CredentialFormatSpec,
  EnvVarBinding,
  OAuthProvider,
} from './oauth-types.js';

/** Format one binding back into its `_env_vars` raw form (`credId` or `credId[n]`). */
export function formatEnvVarValue(binding: EnvVarBinding): string {
  return binding.slice === undefined
    ? binding.credentialPath
    : `${binding.credentialPath}[${binding.slice}]`;
}

/**
 * Reconstruct a provider's `_env_vars`-shaped display map from its parsed
 * bindings. Inverse of the loader's parse step; for inspection / status output.
 */
export function bindingsToEnvVarMap(
  provider: OAuthProvider,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const b of provider.envBindings ?? []) {
    map[b.envName] = formatEnvVarValue(b);
  }
  return map;
}

/**
 * Parse one `_env_vars` value (`"credId"` or `"credId[n]"`) into a binding.
 * Returns null on syntactically invalid input.
 */
export function parseEnvVarValue(
  envName: string,
  raw: string,
): EnvVarBinding | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const m = raw.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
  if (!m) return null;
  const credentialPath = m[1];
  const slice = m[2] === undefined ? undefined : Number(m[2]);
  return slice === undefined
    ? { envName, credentialPath }
    : { envName, credentialPath, slice };
}

/**
 * Distinct credential paths referenced by a provider's env bindings.
 * Composite credentials (multiple sliced bindings) collapse to one entry.
 */
export function distinctCredentialPaths(provider: OAuthProvider): string[] {
  const seen = new Set<string>();
  for (const b of provider.envBindings ?? []) {
    if (!b.credentialPath.includes('/')) seen.add(b.credentialPath);
  }
  return [...seen];
}

/** Bindings referencing a given credential path, in declaration order. */
export function bindingsFor(
  provider: OAuthProvider,
  credentialPath: string,
): EnvVarBinding[] {
  return (provider.envBindings ?? []).filter(
    (b) => b.credentialPath === credentialPath,
  );
}

/** Format spec for one credential, or an empty object if none declared. */
export function formatFor(
  provider: OAuthProvider,
  credentialPath: string,
): CredentialFormatSpec {
  return provider.credentialFormat?.[credentialPath] ?? {};
}

/**
 * Compute the env var value to inject for one binding.
 * Plain bindings return the substitute as-is. Sliced bindings split the
 * substitute on the credential's `sep` and return the n-th part.
 *
 * Returns null when the substitute has fewer fields than the requested slice
 * (which would indicate a misconfigured provider — the caller should warn).
 */
export function materializeEnv(
  binding: EnvVarBinding,
  substitute: string,
  format: CredentialFormatSpec,
): string | null {
  if (binding.slice === undefined) return substitute;
  const sep = format.sep;
  if (!sep) return null;
  const parts = substitute.split(sep);
  if (binding.slice >= parts.length) return null;
  return parts[binding.slice];
}

/**
 * Group incoming `{ envName → rawValue }` import entries by credential path.
 *
 * For composite credentials (multiple sliced bindings), collects all slices,
 * validates completeness (every declared slice index present), and joins them
 * with the credential's `sep`.
 *
 * Env names that don't match any binding are passed through with the env name
 * used as the credential path (preserves legacy behavior — store under the
 * env name itself, useful for ad-hoc keys).
 */
export function groupEnvEntries(
  provider: OAuthProvider,
  entries: Map<string, string>,
): {
  resolved: Map<string, { value: string; sourceEnvNames: string[] }>;
  warnings: string[];
} {
  const resolved = new Map<
    string,
    { value: string; sourceEnvNames: string[] }
  >();
  const warnings: string[] = [];

  // Build envName → binding lookup
  const byEnvName = new Map<string, EnvVarBinding>();
  for (const b of provider.envBindings ?? []) byEnvName.set(b.envName, b);

  // Group inputs by credentialPath
  const grouped = new Map<
    string,
    {
      isComposite: boolean;
      slices: Map<number, string>; // for composite
      direct?: { value: string; envName: string }; // for plain
      sourceEnvNames: string[];
    }
  >();

  for (const [envName, value] of entries) {
    const binding = byEnvName.get(envName);
    const credentialPath = binding?.credentialPath ?? envName;
    let bucket = grouped.get(credentialPath);
    if (!bucket) {
      bucket = {
        isComposite: false,
        slices: new Map(),
        sourceEnvNames: [],
      };
      grouped.set(credentialPath, bucket);
    }
    bucket.sourceEnvNames.push(envName);
    if (binding?.slice !== undefined) {
      bucket.isComposite = true;
      bucket.slices.set(binding.slice, value);
    } else {
      bucket.direct = { value, envName };
    }
  }

  for (const [credentialPath, bucket] of grouped) {
    if (bucket.isComposite) {
      // Validate against declared bindings
      const declared = bindingsFor(provider, credentialPath).filter(
        (b) => b.slice !== undefined,
      );
      const declaredIndices = declared
        .map((b) => b.slice!)
        .sort((a, b) => a - b);
      const missing = declaredIndices.filter((i) => !bucket.slices.has(i));
      if (missing.length > 0) {
        const missingNames = declared
          .filter((b) => missing.includes(b.slice!))
          .map((b) => b.envName);
        warnings.push(
          `${credentialPath}: composite credential incomplete — missing ${missingNames.join(', ')}`,
        );
        continue;
      }
      if (bucket.direct) {
        warnings.push(
          `${credentialPath}: cannot mix sliced and non-sliced env vars for the same credential`,
        );
        continue;
      }
      const sep = formatFor(provider, credentialPath).sep;
      if (!sep) {
        warnings.push(
          `${credentialPath}: sliced env vars require _credential_format.${credentialPath}.sep`,
        );
        continue;
      }
      const ordered = declaredIndices.map((i) => bucket.slices.get(i)!);
      resolved.set(credentialPath, {
        value: ordered.join(sep),
        sourceEnvNames: bucket.sourceEnvNames,
      });
    } else if (bucket.direct) {
      resolved.set(credentialPath, {
        value: bucket.direct.value,
        sourceEnvNames: bucket.sourceEnvNames,
      });
    }
  }

  return { resolved, warnings };
}
