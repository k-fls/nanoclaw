// Intake plan validator.
// Deterministic post-triage gate: checks a proposed decomposition plan
// against the analyzer's signals. Ensures no commit is silently hidden in a
// low-attention group, no break point is coalesced, no conflict escapes
// agent resolution, and every commit appears exactly once in a contiguous
// non-reordered group.
//
// Doctrine: this is strictly mechanical (JSON-in, JSON-out). The triage
// agent forms groups thematically; this script ensures the themes didn't
// quietly bury risk. Runs between triage and human approval.

import { readFileSync } from 'node:fs';
import { z, ZodIssue } from 'zod';
import {
  IntakeReport,
  DiscardedGroup,
  IntroducedGroup,
} from './intake-analyze.js';

// Plan schemas — two layers:
//
// 1. **Draft** (PlanGroupDraftSchema, PlanDraftSchema): what the triage
//    agent emits. Subjective fields only — the human-judgment part. Any
//    derivable field is OMITTED so the model can't get it wrong. `.strict()`
//    on draft groups rejects attempts to smuggle in computed fields.
//
// 2. **Enriched** (PlanGroupSchema, PlanSchema): the full shape the
//    validator checks. Derived fields (kind, files, requiresAgentResolution,
//    index) are computed by `enrichPlan` from the draft + analyzer.
//
// The validator's rules target the agent's actual decisions: group
// placement (contiguity, coverage, overlap, singletons), attention level
// vs. risk signals, cache-key freshness, conflict-resolution flag.
const PlanGroupDraftSchema = z
  .object({
    name: z.string().min(1),
    commits: z.array(z.string().min(1)).min(1),
    attention: z.enum(['none', 'light', 'heavy']),
    expected_outcome: z.enum(['accept', 'reject', 'synthesize', 'unclear']).optional(),
    mechanical_complexity: z.enum(['low', 'medium', 'high']).optional(),
    tags: z.array(z.string()).optional(),
    functional_summary: z.string().optional(),
    grouping_rationale: z.string().optional(),
  })
  .strict();

const PlanDraftSchema = z
  .object({
    target: z.string().min(1),
    source: z.string().min(1),
    base: z.string().min(1),
    cacheKey: z.string().min(1),
    groups: z.array(PlanGroupDraftSchema),
    // Escape-hatch. Non-empty = the agent couldn't form a valid plan for
    // this range; the skill halts and surfaces these reasons to the human
    // for manual intervention. Empty / omitted = plan is complete.
    blockers: z.array(z.string()).optional(),
  })
  .strict();

const PlanGroupSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    kind: z.enum(['clean', 'divergence', 'conflict', 'structural', 'break_point', 'mixed']),
    commits: z.array(z.string().min(1)),
    firstSha: z.string().min(1),
    lastSha: z.string().min(1),
    commitCount: z.number().int().positive(),
    files: z.array(z.string()),
    mechanical_complexity: z.enum(['low', 'medium', 'high']).optional(),
    attention: z.enum(['none', 'light', 'heavy']),
    expected_outcome: z.enum(['accept', 'reject', 'synthesize', 'unclear']).optional(),
    tags: z.array(z.string()).optional(),
    functional_summary: z.string().optional(),
    grouping_rationale: z.string().optional(),
    requiresAgentResolution: z.boolean(),
  })
  .passthrough();

const PlanSchema = z
  .object({
    target: z.string().min(1),
    source: z.string().min(1),
    base: z.string().min(1),
    cacheKey: z.string().min(1),
    groups: z.array(PlanGroupSchema),
    blockers: z.array(z.string()).optional(),
  })
  .passthrough();

export type PlanGroupDraft = z.infer<typeof PlanGroupDraftSchema>;
export type PlanDraft = z.infer<typeof PlanDraftSchema>;
export type PlanGroup = z.infer<typeof PlanGroupSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export { PlanGroupDraftSchema, PlanDraftSchema, PlanGroupSchema, PlanSchema };

export type ViolationSeverity = 'error' | 'warning';

export interface Violation {
  rule: string;
  severity: ViolationSeverity;
  message: string;
  group?: number;          // group.index when applicable
  commit?: string;
  path?: string;
}

export interface ValidateResult {
  violations: Violation[];
  errors: number;
  warnings: number;
}

export interface ValidateOptions {
  // Inline inputs. Either both of these or both file paths (below).
  plan?: Plan;
  analyzer?: IntakeReport;
  planPath?: string;
  analyzerPath?: string;
}

export function validatePlan(opts: ValidateOptions): ValidateResult {
  const rawPlan = opts.plan ?? loadJson<unknown>(opts.planPath!);
  const analyzer = opts.analyzer ?? loadJson<IntakeReport>(opts.analyzerPath!);

  // Shape validation first. Zod gives precise per-field errors with paths,
  // so the triage retry loop gets actionable feedback without us hand-rolling
  // per-field checks. Unknown fields pass through (`.passthrough()`) so
  // prompt additions don't force a schema bump.
  const parsed = PlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    const vs = zodIssuesToViolations(parsed.error.issues, rawPlan);
    return {
      violations: vs,
      errors: vs.filter((v) => v.severity === 'error').length,
      warnings: vs.filter((v) => v.severity === 'warning').length,
    };
  }
  const plan = parsed.data;
  const violations: Violation[] = [];

  // Cache-key attestation. A plan whose cacheKey doesn't match the
  // analyzer's is stale and must not be used.
  if (plan.cacheKey !== analyzer.cacheKey) {
    violations.push({
      rule: 'cache-key-mismatch',
      severity: 'error',
      message: `plan.cacheKey=${plan.cacheKey} but analyzer.cacheKey=${analyzer.cacheKey}; plan is stale`,
    });
  }

  // 1. Contiguity + coverage. Every analyzer commit appears in exactly one
  //    group, and each group's commits are contiguous in analyzer order.
  const analyzerOrder = analyzer.commits.map((c) => c.sha);
  const posByCommit = new Map<string, number>();
  analyzerOrder.forEach((sha, i) => posByCommit.set(sha, i));

  const seen = new Map<string, number>(); // sha -> first group.index that claimed it
  for (const g of plan.groups) {
    // Unknown commits
    for (const sha of g.commits) {
      if (!posByCommit.has(sha)) {
        violations.push({
          rule: 'unknown-commit',
          severity: 'error',
          message: `group #${g.index} "${g.name}" references commit ${sha.slice(0, 7)} not in analyzer range`,
          group: g.index,
          commit: sha,
        });
      }
    }
    // Duplicates
    for (const sha of g.commits) {
      if (seen.has(sha)) {
        violations.push({
          rule: 'duplicate-commit',
          severity: 'error',
          message: `commit ${sha.slice(0, 7)} appears in group #${seen.get(sha)} and group #${g.index}`,
          group: g.index,
          commit: sha,
        });
      } else {
        seen.set(sha, g.index);
      }
    }
    // Contiguity: within a group, positions must be consecutive
    const positions = g.commits
      .map((sha) => posByCommit.get(sha))
      .filter((p): p is number => p !== undefined);
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1] + 1) {
        violations.push({
          rule: 'non-contiguous-group',
          severity: 'error',
          message: `group #${g.index} "${g.name}" commits are not contiguous in analyzer order`,
          group: g.index,
        });
        break;
      }
    }
    // No reordering within group
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] < positions[i - 1]) {
        violations.push({
          rule: 'reordered-commits',
          severity: 'error',
          message: `group #${g.index} "${g.name}" lists commits out of analyzer order`,
          group: g.index,
        });
        break;
      }
    }
  }
  // Missing commits
  for (const sha of analyzerOrder) {
    if (!seen.has(sha)) {
      violations.push({
        rule: 'uncovered-commit',
        severity: 'error',
        message: `commit ${sha.slice(0, 7)} is not in any group`,
        commit: sha,
      });
    }
  }

  // 2. Groups as a whole must be a partition of analyzerOrder — no group
  //    overlaps with another. (Duplicate-commit catches pair-wise overlaps;
  //    this catches the ordering between groups: group A ends at position N,
  //    group B starts at position M > N.)
  const groupsByFirst = plan.groups
    .map((g) => ({
      g,
      first: g.commits[0] ? posByCommit.get(g.commits[0]) : undefined,
      last: g.commits[g.commits.length - 1]
        ? posByCommit.get(g.commits[g.commits.length - 1])
        : undefined,
    }))
    .filter((x): x is { g: PlanGroup; first: number; last: number } =>
      x.first !== undefined && x.last !== undefined,
    )
    .sort((a, b) => a.first - b.first);
  for (let i = 1; i < groupsByFirst.length; i++) {
    if (groupsByFirst[i].first <= groupsByFirst[i - 1].last) {
      violations.push({
        rule: 'overlapping-groups',
        severity: 'error',
        message: `group #${groupsByFirst[i].g.index} "${groupsByFirst[i].g.name}" overlaps group #${groupsByFirst[i - 1].g.index} "${groupsByFirst[i - 1].g.name}" in analyzer order`,
      });
    }
  }

  // 3. Break-point singletons. Every analyzer break point must be its own
  //    singleton group, kind=break_point.
  for (const bp of analyzer.breakPoints) {
    const owner = plan.groups.find((g) => g.commits.includes(bp.sha));
    if (!owner) continue; // already reported as uncovered-commit
    if (owner.commits.length !== 1) {
      violations.push({
        rule: 'break-point-not-singleton',
        severity: 'error',
        message: `break point ${bp.sha.slice(0, 7)} (${bp.refs.join(', ') || 'no tag'}) is in group #${owner.index} "${owner.name}" with ${owner.commits.length} commits; must be a singleton`,
        group: owner.index,
        commit: bp.sha,
      });
    }
  }

  // 4. Intersection coverage. Every file in analyzer.intersection must be
  //    touched by a commit in a group whose attention >= 'light'. Hides-
  //    risk protection: silent inclusion of diverged-surface work in an
  //    attention=none group is the exact failure mode the mechanical floor
  //    used to prevent.
  if (analyzer.intersection.length > 0) {
    const commitToGroup = new Map<string, PlanGroup>();
    for (const g of plan.groups) for (const sha of g.commits) commitToGroup.set(sha, g);
    for (const path of analyzer.intersection) {
      // Non-exempt touchers only. A (commit, path) toucher is exempt when
      // its FileChange has whitespaceOnly=true or revertedAt set: in neither
      // case does the commit leave diverged-surface content behind, so the
      // attention floor has nothing to protect. Rename matches (oldPath ===
      // path) are always counted as non-exempt — a rename on a diverged
      // file genuinely needs eyes.
      const touchers: string[] = [];
      for (const c of analyzer.commits) {
        for (const f of c.files) {
          const hitsNewPath = f.path === path;
          const hitsOldPath = f.oldPath === path;
          if (!hitsNewPath && !hitsOldPath) continue;
          if (hitsNewPath && !hitsOldPath && (f.whitespaceOnly || f.revertedAt)) continue;
          touchers.push(c.sha);
          break; // one entry per commit is enough
        }
      }
      if (touchers.length === 0) continue; // every toucher was exempt
      const coveringGroups = new Set<PlanGroup>();
      for (const sha of touchers) {
        const g = commitToGroup.get(sha);
        if (g) coveringGroups.add(g);
      }
      const maxAttention = [...coveringGroups]
        .map((g) => attentionRank(g.attention))
        .reduce((m, r) => Math.max(m, r), 0);
      if (maxAttention < 1) {
        violations.push({
          rule: 'intersection-file-unattended',
          severity: 'error',
          message: `${path} is in the divergence intersection but lands only in attention=none group(s): ${[...coveringGroups].map((g) => `#${g.index}`).join(', ')}`,
          path,
        });
      }
    }
  }

  // 5. Predicted conflicts → requiresAgentResolution. Every file in
  //    analyzer.predictedConflicts must be in a group whose
  //    requiresAgentResolution is true. Else the skill may skip dispatching
  //    cascade-resolve-conflict and land a mechanical auto-merge on a
  //    conflict git only knew how to surface.
  if (analyzer.predictedConflicts.length > 0) {
    const commitToGroup = new Map<string, PlanGroup>();
    for (const g of plan.groups) for (const sha of g.commits) commitToGroup.set(sha, g);
    for (const path of analyzer.predictedConflicts) {
      const touchers = analyzer.commits
        .filter((c) => c.files.some((f) => f.path === path))
        .map((c) => c.sha);
      const groups = new Set<PlanGroup>();
      for (const sha of touchers) {
        const g = commitToGroup.get(sha);
        if (g) groups.add(g);
      }
      for (const g of groups) {
        if (!g.requiresAgentResolution) {
          violations.push({
            rule: 'conflict-without-resolution-flag',
            severity: 'error',
            message: `${path} has a predicted conflict but group #${g.index} "${g.name}" does not set requiresAgentResolution=true`,
            group: g.index,
            path,
          });
        }
      }
    }
  }

  // 6. Inspection-verdict tags → attention floor. The triage agent reflects
  //    inspector verdicts back into the plan via canonical tags; we enforce
  //    the attention floor from those tags (we can't see the verdicts directly
  //    because they're agent output, so the plan tags are the authoritative
  //    echo). See cascade/docs/inspection.md § Triage outcome mapping.
  for (const g of plan.groups) {
    const tags = g.tags ?? [];
    // Discarded `all-adopt` means the reviewer should reconsider the removal
    // — a judgment call, not mechanical. Requires heavy attention.
    if (tags.includes('discarded-all-adopt') && g.attention !== 'heavy') {
      violations.push({
        rule: 'discarded-all-adopt-needs-heavy-attention',
        severity: 'error',
        message: `group #${g.index} "${g.name}" is tagged discarded-all-adopt but attention=${g.attention}`,
        group: g.index,
      });
    }
    // Mixed / inconclusive verdicts — reviewer has to read per-commit.
    for (const tag of ['discarded-mixed', 'discarded-inconclusive', 'introduced-mixed', 'introduced-inconclusive']) {
      if (tags.includes(tag) && g.attention === 'none') {
        violations.push({
          rule: 'inspection-mixed-or-inconclusive-needs-attention',
          severity: 'error',
          message: `group #${g.index} "${g.name}" is tagged ${tag} but attention=none`,
          group: g.index,
        });
      }
    }
    // Introduced `all-remove` requires the reviewer to do a post-merge
    // `git rm`. Not rubber-stamp-able — attention ≥ light.
    if (tags.includes('introduced-all-remove') && g.attention === 'none') {
      violations.push({
        rule: 'introduced-all-remove-needs-attention',
        severity: 'error',
        message: `group #${g.index} "${g.name}" is tagged introduced-all-remove (post-merge cleanup needed) but attention=none`,
        group: g.index,
      });
    }
  }

  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.filter((v) => v.severity === 'warning').length;
  return { violations, errors, warnings };
}

// ---------------- enrichment ----------------

// Stamp the derived fields onto a draft plan. The agent emits only
// subjective fields + the grouping decision (commits[]); this computes the
// mechanical fields so the model can never get them wrong.
//
// Derived per group:
//   - kind: worst primaryKind among its commits, `mixed` if ≥ 2 severities > 0
//   - files: sorted union of each commit's file paths
//   - firstSha / lastSha / commitCount: from commits[] in analyzer order
//   - requiresAgentResolution: kind === 'conflict' || attention === 'heavy'
//   - index: sort groups by first-commit analyzer position, then 0..N-1
//
// Execution order is the groups' natural order (sorted by first-commit
// analyzer position) — upstream commit order is physics, not a choice.
export function enrichPlan(draft: PlanDraft, analyzer: IntakeReport): Plan {
  const posByCommit = new Map<string, number>();
  analyzer.commits.forEach((c, i) => posByCommit.set(c.sha, i));
  const commitBySha = new Map(analyzer.commits.map((c) => [c.sha, c]));

  // Sort groups by first-commit analyzer position so `index` is deterministic
  // and monotonic. Groups whose commits aren't all in the analyzer still get
  // sorted — the validator catches unknown/uncovered commits downstream.
  const sortKey = (g: PlanGroupDraft): number => {
    const first = g.commits[0];
    const pos = first ? posByCommit.get(first) : undefined;
    return pos ?? Number.MAX_SAFE_INTEGER;
  };
  const sortedDrafts = [...draft.groups].sort((a, b) => sortKey(a) - sortKey(b));

  const enrichedGroups: PlanGroup[] = sortedDrafts.map((g, idx) => {
    const kind = computeGroupKind(g, commitBySha);
    const files = unionFiles(g, commitBySha);
    const requiresAgentResolution =
      kind === 'conflict' || g.attention === 'heavy';
    return {
      index: idx,
      name: g.name,
      kind,
      commits: [...g.commits],
      firstSha: g.commits[0],
      lastSha: g.commits[g.commits.length - 1],
      commitCount: g.commits.length,
      files,
      mechanical_complexity: g.mechanical_complexity,
      attention: g.attention,
      expected_outcome: g.expected_outcome,
      tags: g.tags,
      functional_summary: g.functional_summary,
      grouping_rationale: g.grouping_rationale,
      requiresAgentResolution,
    };
  });

  return {
    target: draft.target,
    source: draft.source,
    base: draft.base,
    cacheKey: draft.cacheKey,
    groups: enrichedGroups,
    blockers: draft.blockers,
  };
}

const SEVERITY_RANK: Record<string, number> = {
  clean: 0,
  structural: 1,
  divergence: 2,
  conflict: 3,
  break_point: 0, // handled separately below
};

function computeGroupKind(
  g: PlanGroupDraft,
  commitBySha: Map<string, IntakeReport['commits'][number]>,
): PlanGroup['kind'] {
  // Break point: any commit with primaryKind === 'break_point' → the group
  // kind is break_point (the validator will then enforce singleton).
  for (const sha of g.commits) {
    if (commitBySha.get(sha)?.primaryKind === 'break_point') return 'break_point';
  }

  // Collect severities above `clean` present in the group.
  const severities = new Set<string>();
  for (const sha of g.commits) {
    const pk = commitBySha.get(sha)?.primaryKind;
    if (pk && (SEVERITY_RANK[pk] ?? 0) > 0) severities.add(pk);
  }
  if (severities.size === 0) return 'clean';
  if (severities.size > 1) return 'mixed';
  // Single non-clean severity present.
  return severities.values().next().value as PlanGroup['kind'];
}

function unionFiles(
  g: PlanGroupDraft,
  commitBySha: Map<string, IntakeReport['commits'][number]>,
): string[] {
  const set = new Set<string>();
  for (const sha of g.commits) {
    const c = commitBySha.get(sha);
    if (!c) continue;
    for (const f of c.files) {
      set.add(f.path);
      if (f.oldPath) set.add(f.oldPath);
    }
  }
  return [...set].sort();
}

// ---------------- helpers ----------------

// Map zod issues into our Violation shape. Attaches the group's index field
// when the issue's path targets a specific group.
function zodIssuesToViolations(issues: ZodIssue[], rawPlan: unknown): Violation[] {
  const out: Violation[] = [];
  for (const iss of issues) {
    const group = extractGroupIndex(iss.path, rawPlan);
    const field = iss.path.join('.');
    const message = `${field || 'plan'}: ${iss.message}`;
    out.push({ rule: 'malformed-plan', severity: 'error', message, group });
  }
  return out;
}

// Returns the group's `index` field if this issue is inside `groups[N]`.
function extractGroupIndex(path: PropertyKey[], rawPlan: unknown): number | undefined {
  if (path.length < 2 || path[0] !== 'groups') return undefined;
  const i = path[1];
  if (typeof i !== 'number') return undefined;
  const groups = (rawPlan as { groups?: unknown[] })?.groups;
  if (!Array.isArray(groups)) return undefined;
  const g = groups[i] as { index?: unknown } | undefined;
  return typeof g?.index === 'number' ? g.index : i;
}

function attentionRank(a: PlanGroup['attention']): number {
  return a === 'heavy' ? 2 : a === 'light' ? 1 : 0;
}

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export function formatValidateReport(r: ValidateResult): string {
  if (r.violations.length === 0) return 'intake-validate: plan is valid\n';
  const lines: string[] = [];
  for (const v of r.violations) {
    const tag = v.severity === 'error' ? '[error]' : '[warning]';
    lines.push(`${tag} ${v.rule}: ${v.message}`);
  }
  lines.push('');
  lines.push(`summary: ${r.errors} error(s), ${r.warnings} warning(s)`);
  lines.push(r.errors === 0 ? '→ PASS (warnings only)' : '→ FAIL');
  return lines.join('\n') + '\n';
}

// Unused export stubs: keep inspection-group types referenced so module
// re-exports are stable if future checks consume them directly.
export type _DiscardedGroupShape = DiscardedGroup;
export type _IntroducedGroupShape = IntroducedGroup;
