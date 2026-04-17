import { describe, expect, it } from 'vitest';
import { validatePlan, Plan } from '../scripts/intake-validate.js';
import type { IntakeReport } from '../scripts/intake-analyze.js';

// Minimal analyzer fixture. Only the fields the validator reads matter.
function makeAnalyzer(overrides: Partial<IntakeReport> = {}): IntakeReport {
  return {
    target: 'main',
    source: 'upstream/main',
    base: 'basesha',
    rangeCount: 3,
    commits: [
      {
        sha: 'aaa',
        shortSha: 'aaa',
        subject: 'c1',
        author: 'x',
        authorDate: '2026-01-01T00:00:00Z',
        parents: [],
        isMerge: false,
        files: [{ status: 'M', path: 'src/a.ts' }],
        kinds: ['clean'],
        primaryKind: 'clean',
        tags: [],
      },
      {
        sha: 'bbb',
        shortSha: 'bbb',
        subject: 'c2',
        author: 'x',
        authorDate: '2026-01-02T00:00:00Z',
        parents: [],
        isMerge: false,
        files: [{ status: 'M', path: 'src/div.ts' }],
        kinds: ['divergence'],
        primaryKind: 'divergence',
        tags: [],
      },
      {
        sha: 'ccc',
        shortSha: 'ccc',
        subject: 'c3',
        author: 'x',
        authorDate: '2026-01-03T00:00:00Z',
        parents: [],
        isMerge: false,
        files: [{ status: 'M', path: 'src/c.ts' }],
        kinds: ['clean'],
        primaryKind: 'clean',
        tags: [],
      },
    ],
    aggregateFiles: ['src/a.ts', 'src/c.ts', 'src/div.ts'],
    divergenceFiles: ['src/div.ts'],
    intersection: ['src/div.ts'],
    predictedConflicts: [],
    breakPoints: [],
    renames: [],
    flsDeletionGroups: [],
    cacheKey: 'cacheX',
    ...overrides,
  };
}

function plan(groups: Plan['groups'], overrides: Partial<Plan> = {}): Plan {
  return {
    target: 'main',
    source: 'upstream/main',
    base: 'basesha',
    cacheKey: 'cacheX',
    groups,
    ...overrides,
  };
}

describe('validatePlan — valid baselines', () => {
  it('accepts a partition that covers every commit contiguously', () => {
    const p = plan([
      {
        index: 0,
        name: 'clean-1',
        kind: 'clean',
        commits: ['aaa'],
        attention: 'none',
      },
      {
        index: 1,
        name: 'div-1',
        kind: 'divergence',
        commits: ['bbb'],
        attention: 'light',
      },
      {
        index: 2,
        name: 'clean-2',
        kind: 'clean',
        commits: ['ccc'],
        attention: 'none',
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.errors).toBe(0);
  });
});

describe('validatePlan — cache-key mismatch', () => {
  it('errors when plan.cacheKey differs from analyzer.cacheKey', () => {
    const p = plan(
      [
        { index: 0, name: 'x', kind: 'clean', commits: ['aaa', 'bbb', 'ccc'], attention: 'light' },
      ],
      { cacheKey: 'stale' },
    );
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('cache-key-mismatch');
  });
});

describe('validatePlan — contiguity and coverage', () => {
  it('errors on missing commits', () => {
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      // bbb, ccc missing
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    const rules = r.violations.map((v) => v.rule);
    expect(rules).toContain('uncovered-commit');
  });

  it('errors on duplicated commit across groups', () => {
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa', 'bbb'], attention: 'light' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb', 'ccc'], attention: 'light' },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('duplicate-commit');
  });

  it('errors on non-contiguous group (gap inside group)', () => {
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa', 'ccc'], attention: 'light' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'light' },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('non-contiguous-group');
  });

  it('errors on reordered commits inside a group', () => {
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['bbb', 'aaa'], attention: 'light' },
      { index: 1, name: 'y', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    const rules = r.violations.map((v) => v.rule);
    // bbb-then-aaa is reordered. Also: 'x' will look non-contiguous because
    // positions 1,0 aren't consecutive ascending; either rule catches it.
    expect(rules.some((r) => r === 'reordered-commits' || r === 'non-contiguous-group')).toBe(true);
  });

  it('errors when groups overlap between themselves', () => {
    // Group A covers aaa-bbb, group B covers bbb-ccc (bbb overlaps).
    // duplicate-commit will fire; this test ensures it does.
    const p = plan([
      { index: 0, name: 'a', kind: 'divergence', commits: ['aaa', 'bbb'], attention: 'light' },
      { index: 1, name: 'b', kind: 'divergence', commits: ['bbb', 'ccc'], attention: 'light' },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('duplicate-commit');
  });
});

describe('validatePlan — intersection coverage', () => {
  it('errors when a divergent file lands in attention=none only', () => {
    // src/div.ts is in intersection; group claiming bbb is attention=none.
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'none' },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('intersection-file-unattended');
  });

  it('passes when the divergent file is in a light-or-heavier group', () => {
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'light' },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.filter((v) => v.rule === 'intersection-file-unattended')).toHaveLength(0);
  });
});

describe('validatePlan — predicted conflicts require resolution flag', () => {
  it('errors when a conflicted file lands in a group without requiresAgentResolution', () => {
    const a = makeAnalyzer({ predictedConflicts: ['src/div.ts'] });
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'conflict', commits: ['bbb'], attention: 'heavy' },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
    expect(r.violations.map((v) => v.rule)).toContain('conflict-without-resolution-flag');
  });

  it('passes when requiresAgentResolution is set on the conflict group', () => {
    const a = makeAnalyzer({ predictedConflicts: ['src/div.ts'] });
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      {
        index: 1,
        name: 'y',
        kind: 'conflict',
        commits: ['bbb'],
        attention: 'heavy',
        requiresAgentResolution: true,
      },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
    expect(r.violations.filter((v) => v.rule === 'conflict-without-resolution-flag')).toHaveLength(0);
  });
});

describe('validatePlan — break-point singleton rule', () => {
  it('errors when a break point is coalesced with a neighbor', () => {
    const a = makeAnalyzer({ breakPoints: [{ sha: 'bbb', refs: ['v1.0'] }] });
    // Group 'y' contains both bbb (break point) and ccc — violation.
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'break_point', commits: ['bbb', 'ccc'], attention: 'light' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
    expect(r.violations.map((v) => v.rule)).toContain('break-point-not-singleton');
  });

});

describe('validatePlan — deletion rationale attention floors', () => {
  it('errors when rationale-reopened group is not attention=heavy', () => {
    const p = plan([
      {
        index: 0,
        name: 'x',
        kind: 'clean',
        commits: ['aaa', 'bbb', 'ccc'],
        attention: 'light',
        tags: ['deletion-rationale-reopened'],
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('deletion-reopened-needs-heavy-attention');
  });

  it('errors when rationale-inconclusive group is attention=none', () => {
    const p = plan([
      {
        index: 0,
        name: 'x',
        kind: 'clean',
        commits: ['aaa', 'bbb', 'ccc'],
        attention: 'none',
        tags: ['deletion-rationale-inconclusive'],
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('deletion-inconclusive-needs-attention');
  });
});

