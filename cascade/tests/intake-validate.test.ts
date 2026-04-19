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
    discardedGroups: [],
    introducedGroups: [],
    cacheKey: 'cacheX',
    ...overrides,
  };
}

// Test-helper shape: subjective fields + commits, like the agent's draft.
// The helper synthesizes the derived fields (firstSha/lastSha/commitCount/
// files/requiresAgentResolution) so tests don't have to repeat them. Tests
// that want to exercise derived-field validation should build plans directly.
interface PartialGroup {
  index: number;
  name: string;
  kind: Plan['groups'][number]['kind'];
  commits: string[];
  attention: Plan['groups'][number]['attention'];
  expected_outcome?: Plan['groups'][number]['expected_outcome'];
  mechanical_complexity?: Plan['groups'][number]['mechanical_complexity'];
  tags?: string[];
  functional_summary?: string;
  grouping_rationale?: string;
  firstSha?: string;
  lastSha?: string;
  commitCount?: number;
  files?: string[];
  requiresAgentResolution?: boolean;
}

function plan(groups: PartialGroup[], overrides: Partial<Plan> = {}): Plan {
  const enrichedGroups = groups.map((g) => ({
    ...g,
    firstSha: g.firstSha ?? g.commits[0],
    lastSha: g.lastSha ?? g.commits[g.commits.length - 1],
    commitCount: g.commitCount ?? g.commits.length,
    files: g.files ?? [],
    requiresAgentResolution:
      g.requiresAgentResolution ??
      (g.kind === 'conflict' || g.attention === 'heavy'),
  })) as Plan['groups'];
  return {
    target: 'main',
    source: 'upstream/main',
    base: 'basesha',
    cacheKey: 'cacheX',
    groups: enrichedGroups,
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

  it('exempts a path whose only toucher has whitespaceOnly=true', () => {
    const a = makeAnalyzer();
    // Replace bbb's touch on src/div.ts with a whitespace-only touch.
    a.commits[1].files = [{ status: 'M', path: 'src/div.ts', whitespaceOnly: true }];
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'none' },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
    expect(r.violations.filter((v) => v.rule === 'intersection-file-unattended')).toHaveLength(0);
  });

  it('exempts a path whose only toucher has revertedAt set', () => {
    const a = makeAnalyzer();
    a.commits[1].files = [{ status: 'M', path: 'src/div.ts', revertedAt: 'ccc' }];
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'none' },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
    expect(r.violations.filter((v) => v.rule === 'intersection-file-unattended')).toHaveLength(0);
  });

  it('still fires when one toucher is exempt but another is not', () => {
    // Extend fixture: add a second commit touching src/div.ts without signals.
    const a = makeAnalyzer();
    a.commits[1].files = [{ status: 'M', path: 'src/div.ts', whitespaceOnly: true }];
    a.commits[2].files = [{ status: 'M', path: 'src/div.ts' }]; // non-exempt
    a.intersection = ['src/div.ts'];
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb', 'ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
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
  // `requiresAgentResolution` is derived (kind==='conflict' || attention==='heavy').
  // The rule fires when a predictedConflicts file lands in a group with
  // neither — e.g. a divergence commit touching a file that merge-tree
  // predicted conflicts on. The agent's fix is to raise attention.

  it('errors when a conflicted file lands in a divergence+light group', () => {
    const a = makeAnalyzer({ predictedConflicts: ['src/div.ts'] });
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      // Divergence + light → derived requiresAgentResolution=false.
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'light' },
      { index: 2, name: 'z', kind: 'clean', commits: ['ccc'], attention: 'none' },
    ]);
    const r = validatePlan({ plan: p, analyzer: a });
    expect(r.violations.map((v) => v.rule)).toContain('conflict-without-resolution-flag');
  });

  it('passes when attention is heavy (derived flag becomes true)', () => {
    const a = makeAnalyzer({ predictedConflicts: ['src/div.ts'] });
    const p = plan([
      { index: 0, name: 'x', kind: 'clean', commits: ['aaa'], attention: 'none' },
      { index: 1, name: 'y', kind: 'divergence', commits: ['bbb'], attention: 'heavy' },
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

describe('validatePlan — inspection-verdict attention floors', () => {
  it('errors when a discarded-all-adopt group is not attention=heavy', () => {
    const p = plan([
      {
        index: 0,
        name: 'x',
        kind: 'clean',
        commits: ['aaa', 'bbb', 'ccc'],
        attention: 'light',
        tags: ['discarded-all-adopt'],
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('discarded-all-adopt-needs-heavy-attention');
  });

  it('errors when a discarded-inconclusive group is attention=none', () => {
    const p = plan([
      {
        index: 0,
        name: 'x',
        kind: 'clean',
        commits: ['aaa', 'bbb', 'ccc'],
        attention: 'none',
        tags: ['discarded-inconclusive'],
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('inspection-mixed-or-inconclusive-needs-attention');
  });

  it('errors when an introduced-mixed group is attention=none', () => {
    const p = plan([
      {
        index: 0,
        name: 'x',
        kind: 'clean',
        commits: ['aaa', 'bbb', 'ccc'],
        attention: 'none',
        tags: ['introduced-mixed'],
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('inspection-mixed-or-inconclusive-needs-attention');
  });

  it('errors when an introduced-all-remove group is attention=none', () => {
    const p = plan([
      {
        index: 0,
        name: 'x',
        kind: 'clean',
        commits: ['aaa', 'bbb', 'ccc'],
        attention: 'none',
        tags: ['introduced-all-remove', 'post-merge-cleanup'],
      },
    ]);
    const r = validatePlan({ plan: p, analyzer: makeAnalyzer() });
    expect(r.violations.map((v) => v.rule)).toContain('introduced-all-remove-needs-attention');
  });
});

