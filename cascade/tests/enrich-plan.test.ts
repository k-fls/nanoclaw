import { describe, expect, it } from 'vitest';
import { enrichPlan, type PlanDraft } from '../scripts/intake-validate.js';
import type { IntakeReport } from '../scripts/intake-analyze.js';

function makeAnalyzer(
  overrides: Partial<IntakeReport> = {},
): IntakeReport {
  return {
    target: 'main',
    source: 'upstream/main',
    base: 'basesha',
    rangeCount: 4,
    commits: [
      {
        sha: 'aaa',
        subject: 'c1',
        author: 'x',
        authorDate: '2026-01-01',
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
        authorDate: '2026-01-02',
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
        authorDate: '2026-01-03',
        parents: [],
        isMerge: false,
        files: [
          { status: 'R', path: 'src/renamed.ts', oldPath: 'src/a.ts' },
        ],
        kinds: ['structural'],
        primaryKind: 'structural',
        tags: [],
      },
      {
        sha: 'ddd',
        subject: 'v1.0',
        author: 'x',
        authorDate: '2026-01-04',
        parents: [],
        isMerge: false,
        files: [{ status: 'M', path: 'src/tag.ts' }],
        kinds: ['break_point'],
        primaryKind: 'break_point',
        tags: ['v1.0'],
      },
    ],
    aggregateFiles: ['src/a.ts', 'src/div.ts', 'src/renamed.ts', 'src/tag.ts'],
    divergenceFiles: ['src/div.ts'],
    intersection: ['src/div.ts'],
    predictedConflicts: [],
    breakPoints: [{ sha: 'ddd', refs: ['v1.0'] }],
    renames: [{ from: 'src/a.ts', to: 'src/renamed.ts', sha: 'ccc' }],
    discardedGroups: [],
    introducedGroups: [],
    cacheKey: 'cacheX',
    ...overrides,
  };
}

const baseDraft = {
  target: 'main',
  source: 'upstream/main',
  base: 'basesha',
  cacheKey: 'cacheX',
};

describe('enrichPlan — derived kind', () => {
  it('all-clean group → kind=clean', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        { name: 'g1', commits: ['aaa'], attention: 'none' },
        { name: 'g2', commits: ['bbb'], attention: 'light' },
        { name: 'g3', commits: ['ccc'], attention: 'light' },
        { name: 'g4', commits: ['ddd'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    expect(p.groups[0].kind).toBe('clean');
  });

  it('group with a divergence commit → kind=divergence', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        { name: 'g1', commits: ['aaa', 'bbb'], attention: 'light' },
        { name: 'g2', commits: ['ccc'], attention: 'light' },
        { name: 'g3', commits: ['ddd'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    // g1 has a clean + a divergence commit — divergence wins.
    expect(p.groups[0].kind).toBe('divergence');
  });

  it('group with divergence + structural → kind=mixed', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        { name: 'g1', commits: ['aaa'], attention: 'none' },
        { name: 'g2', commits: ['bbb', 'ccc'], attention: 'light' },
        { name: 'g3', commits: ['ddd'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    expect(p.groups[1].kind).toBe('mixed');
  });

  it('any commit with primaryKind=break_point → kind=break_point', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        { name: 'g1', commits: ['aaa', 'bbb', 'ccc'], attention: 'light' },
        { name: 'g2', commits: ['ddd'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    expect(p.groups[1].kind).toBe('break_point');
  });
});

describe('enrichPlan — derived fields', () => {
  it('files = sorted union of constituent commits\' paths (including renames\' oldPath)', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        // includes the rename commit + its pre-rename source
        { name: 'g1', commits: ['aaa', 'ccc'], attention: 'light' },
        { name: 'g2', commits: ['bbb'], attention: 'light' },
        { name: 'g3', commits: ['ddd'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    expect(p.groups[0].files).toEqual(['src/a.ts', 'src/renamed.ts']);
  });

  it('requiresAgentResolution = kind=conflict OR attention=heavy', () => {
    const analyzer = makeAnalyzer({
      commits: makeAnalyzer().commits.map((c, i) =>
        i === 1 ? { ...c, primaryKind: 'conflict', kinds: ['conflict'] } : c,
      ),
    });
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        // contains a conflict commit → requiresAgentResolution true regardless
        { name: 'g1', commits: ['aaa', 'bbb'], attention: 'light' },
        // heavy attention alone → true
        { name: 'g2', commits: ['ccc'], attention: 'heavy' },
        // clean + not heavy → false
        { name: 'g3', commits: ['ddd'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, analyzer);
    expect(p.groups[0].requiresAgentResolution).toBe(true);
    expect(p.groups[1].requiresAgentResolution).toBe(true);
    // g3 contains ddd which has primaryKind=break_point → kind=break_point,
    // and attention=light. No conflict, no heavy → false.
    expect(p.groups[2].requiresAgentResolution).toBe(false);
  });
});

describe('enrichPlan — group ordering', () => {
  it('groups are sorted by first-commit analyzer position, index = 0..N-1', () => {
    // Agent emits groups out of order intentionally.
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        { name: 'late', commits: ['ddd'], attention: 'light' },
        { name: 'early', commits: ['aaa'], attention: 'none' },
        { name: 'mid', commits: ['bbb', 'ccc'], attention: 'light' },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    expect(p.groups.map((g) => g.name)).toEqual(['early', 'mid', 'late']);
    expect(p.groups.map((g) => g.index)).toEqual([0, 1, 2]);
  });
});

describe('enrichPlan — passthrough', () => {
  it('preserves subjective fields unchanged', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [
        {
          name: 'g1',
          commits: ['aaa', 'bbb', 'ccc', 'ddd'],
          attention: 'heavy',
          expected_outcome: 'unclear',
          mechanical_complexity: 'high',
          tags: ['touches:src/div.ts(diverged)'],
          functional_summary: 'does a thing',
          grouping_rationale: 'shared theme X',
        },
      ],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    const g = p.groups[0];
    expect(g.attention).toBe('heavy');
    expect(g.expected_outcome).toBe('unclear');
    expect(g.mechanical_complexity).toBe('high');
    expect(g.tags).toEqual(['touches:src/div.ts(diverged)']);
    expect(g.functional_summary).toBe('does a thing');
    expect(g.grouping_rationale).toBe('shared theme X');
  });

  it('preserves blockers', () => {
    const draft: PlanDraft = {
      ...baseDraft,
      groups: [],
      blockers: ['cannot partition — reason X'],
    };
    const p = enrichPlan(draft, makeAnalyzer());
    expect(p.blockers).toEqual(['cannot partition — reason X']);
  });
});
