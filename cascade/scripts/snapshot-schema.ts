// Edition snapshot schema + validator.
// Implements cascade/docs/artifacts.md § Edition snapshot.
//
// Compatibility matrix (tag's schema_version vs. consumer CLI's MAX):
//   tag < MAX  → read through
//   tag = MAX  → read
//   tag > MAX  → refuse with unsupported-snapshot-version
//
// Additive changes (new fields) leave schema_version unchanged; older
// consumers read fewer fields. Breaking changes (rename/remove/semantic
// shift) bump schema_version.

export const MAX_SNAPSHOT_SCHEMA = 1;

export interface SnapshotAdapter {
  skill: string;
  channel: string;
}

export interface SnapshotIncluded {
  channels: string[];
  skills: string[];
  adapters: SnapshotAdapter[];
}

export interface EditionSnapshot {
  schema_version: number;
  edition: string;
  version: string;
  generated_at: string;
  core_version: string | null;
  upstream_version: string | null;
  included: SnapshotIncluded;
  ownership_map: Record<string, string>;
  branch_classes: string;
}

export class UnsupportedSnapshotVersionError extends Error {
  kind = 'unsupported-snapshot-version' as const;
  constructor(public tagSchema: number, public cliMax: number) {
    super(
      `unsupported-snapshot-version: tag has schema_version=${tagSchema} but this CLI supports up to ${cliMax}. Update the cascade submodule in the consumer repo.`,
    );
  }
}

export class SnapshotValidationError extends Error {
  kind = 'snapshot-invalid' as const;
  constructor(public path: string, message: string) {
    super(`snapshot invalid at ${path}: ${message}`);
  }
}

function requireString(val: unknown, path: string): string {
  if (typeof val !== 'string') {
    throw new SnapshotValidationError(path, `expected string, got ${typeof val}`);
  }
  return val;
}

function requireStringOrNull(val: unknown, path: string): string | null {
  if (val === null) return null;
  return requireString(val, path);
}

function requireInt(val: unknown, path: string): number {
  if (typeof val !== 'number' || !Number.isInteger(val)) {
    throw new SnapshotValidationError(path, `expected integer, got ${typeof val}`);
  }
  return val;
}

function requireObject(val: unknown, path: string): Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new SnapshotValidationError(path, `expected object`);
  }
  return val as Record<string, unknown>;
}

function requireStringArray(val: unknown, path: string): string[] {
  if (!Array.isArray(val)) {
    throw new SnapshotValidationError(path, `expected array`);
  }
  return val.map((v, i) => requireString(v, `${path}[${i}]`));
}

const FOUR_PART = /^\d+\.\d+\.\d+\.\d+$/;
const THREE_PART = /^\d+\.\d+\.\d+$/;

// Validate parsed JSON as an EditionSnapshot. Throws on schema mismatch.
// Callers that need to reject too-new schemas use assertSchemaSupported.
export function validateSnapshot(raw: unknown): EditionSnapshot {
  const o = requireObject(raw, '$');
  const schema_version = requireInt(o.schema_version, 'schema_version');
  if (schema_version < 1) {
    throw new SnapshotValidationError('schema_version', `must be >= 1`);
  }

  const edition = requireString(o.edition, 'edition');
  if (!/^[^/]+$/.test(edition)) {
    throw new SnapshotValidationError('edition', 'must be a single path segment');
  }

  const version = requireString(o.version, 'version');
  if (!FOUR_PART.test(version)) {
    throw new SnapshotValidationError('version', 'must be A.B.C.D');
  }

  const generated_at = requireString(o.generated_at, 'generated_at');
  // Minimal ISO-8601 check: must parse via Date.
  if (Number.isNaN(Date.parse(generated_at))) {
    throw new SnapshotValidationError('generated_at', 'not a valid ISO timestamp');
  }

  const core_version = requireStringOrNull(o.core_version, 'core_version');
  if (core_version !== null && !FOUR_PART.test(core_version)) {
    throw new SnapshotValidationError('core_version', 'must be A.B.C.D or null');
  }

  const upstream_version = requireStringOrNull(o.upstream_version, 'upstream_version');
  if (upstream_version !== null && !THREE_PART.test(upstream_version)) {
    throw new SnapshotValidationError('upstream_version', 'must be A.B.C or null');
  }

  const inc = requireObject(o.included, 'included');
  const channels = requireStringArray(inc.channels, 'included.channels');
  const skills = requireStringArray(inc.skills, 'included.skills');
  if (!Array.isArray(inc.adapters)) {
    throw new SnapshotValidationError('included.adapters', 'expected array');
  }
  const adapters: SnapshotAdapter[] = inc.adapters.map((a, i) => {
    const ao = requireObject(a, `included.adapters[${i}]`);
    return {
      skill: requireString(ao.skill, `included.adapters[${i}].skill`),
      channel: requireString(ao.channel, `included.adapters[${i}].channel`),
    };
  });

  const omRaw = requireObject(o.ownership_map, 'ownership_map');
  const ownership_map: Record<string, string> = {};
  for (const [k, v] of Object.entries(omRaw)) {
    ownership_map[k] = requireString(v, `ownership_map.${k}`);
  }

  const branch_classes = requireString(o.branch_classes, 'branch_classes');

  return {
    schema_version,
    edition,
    version,
    generated_at,
    core_version,
    upstream_version,
    included: { channels, skills, adapters },
    ownership_map,
    branch_classes,
  };
}

// Refuse when tag schema is newer than what this CLI supports. Older schemas
// are read-through per the compatibility matrix.
export function assertSchemaSupported(schemaVersion: number): void {
  if (schemaVersion > MAX_SNAPSHOT_SCHEMA) {
    throw new UnsupportedSnapshotVersionError(schemaVersion, MAX_SNAPSHOT_SCHEMA);
  }
}
