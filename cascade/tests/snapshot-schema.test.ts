import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_SCHEMA,
  SnapshotValidationError,
  UnsupportedSnapshotVersionError,
  assertSchemaSupported,
  validateSnapshot,
} from '../scripts/snapshot-schema.js';

const VALID = {
  schema_version: 1,
  edition: 'starter',
  version: '1.9.0.1',
  generated_at: '2026-04-13T10:00:00Z',
  core_version: '1.9.0.5',
  upstream_version: '1.9.0',
  included: {
    channels: ['whatsapp'],
    skills: ['image-vision'],
    adapters: [{ skill: 'reactions', channel: 'whatsapp' }],
  },
  ownership_map: { 'src/a.ts': 'core' },
  branch_classes: 'classes: []\n',
};

describe('validateSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const r = validateSnapshot(VALID);
    expect(r.edition).toBe('starter');
    expect(r.included.adapters).toHaveLength(1);
  });

  it('rejects missing schema_version', () => {
    const { schema_version: _, ...rest } = VALID;
    expect(() => validateSnapshot(rest)).toThrow(SnapshotValidationError);
  });

  it('rejects non-4-part version', () => {
    expect(() => validateSnapshot({ ...VALID, version: '1.9.0' })).toThrow(/A.B.C.D/);
  });

  it('rejects non-3-part upstream_version', () => {
    expect(() => validateSnapshot({ ...VALID, upstream_version: '1.9.0.0' })).toThrow(
      /A.B.C or null/,
    );
  });

  it('accepts null core_version + upstream_version', () => {
    const r = validateSnapshot({
      ...VALID,
      core_version: null,
      upstream_version: null,
    });
    expect(r.core_version).toBeNull();
    expect(r.upstream_version).toBeNull();
  });

  it('rejects adapters missing skill', () => {
    expect(() =>
      validateSnapshot({
        ...VALID,
        included: { ...VALID.included, adapters: [{ channel: 'x' }] },
      }),
    ).toThrow(/skill/);
  });

  it('rejects invalid generated_at', () => {
    expect(() => validateSnapshot({ ...VALID, generated_at: 'yesterday' })).toThrow(
      /valid ISO/,
    );
  });
});

describe('assertSchemaSupported', () => {
  it('accepts current MAX', () => {
    expect(() => assertSchemaSupported(MAX_SNAPSHOT_SCHEMA)).not.toThrow();
  });

  it('accepts older schemas (< MAX)', () => {
    expect(() => assertSchemaSupported(1)).not.toThrow();
  });

  it('refuses newer schemas (> MAX)', () => {
    expect(() => assertSchemaSupported(MAX_SNAPSHOT_SCHEMA + 1)).toThrow(
      UnsupportedSnapshotVersionError,
    );
  });
});
