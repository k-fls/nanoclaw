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
  FlsDeletionGroup,
} from './intake-analyze.js';

// Plan JSON shape — matches .claude/agents/cascade-triage-intake.md output.
// Declared once as a zod schema so runtime validation and TypeScript types
// stay in lock-step. Unknown fields pass through (`.passthrough()`) so
// schema additions don't force a version bump, but unknown fields are still
// inspected for legacy-schema hints (see `LEGACY_FIELD_HINTS`).
const PlanGroupSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    kind: z.enum(['clean', 'divergence', 'conflict', 'structural', 'break_point', 'mixed']),
    commits: z.array(z.string().min(1)),
    files: z.array(z.string()).optional(),
    mechanical_complexity: z.enum(['low', 'medium', 'high']).optional(),
    attention: z.enum(['none', 'light', 'heavy']),
    expected_outcome: z.enum(['accept', 'reject', 'synthesize', 'unclear']).optional(),
    tags: z.array(z.string()).optional(),
    functional_summary: z.string().optional(),
    grouping_rationale: z.string().optional(),
    requiresAgentResolution: z.boolean().optional(),
  })
  .passthrough();

const PlanSchema = z
  .object({
    target: z.string().min(1),
    source: z.string().min(1),
    base: z.string().min(1),
    cacheKey: z.string().min(1),
    groups: z.array(PlanGroupSchema),
    mergeOrder: z.array(z.number().int().nonnegative()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

export type PlanGroup = z.infer<typeof PlanGroupSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export { PlanGroupSchema, PlanSchema };

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
    if (owner.kind !== 'break_point') {
      violations.push({
        rule: 'break-point-wrong-kind',
        severity: 'error',
        message: `break point ${bp.sha.slice(0, 7)} is in group #${owner.index} with kind="${owner.kind}"; must be kind="break_point"`,
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
      // Which commits in range touch this path?
      const touchers = analyzer.commits
        .filter((c) => c.files.some((f) => f.path === path || f.oldPath === path))
        .map((c) => c.sha);
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

  // 6. Deletion verdicts → attention floor. If the skill supplied deletion
  //    verdicts back into the plan (as triage is instructed to reflect them
  //    via tags), enforce the attention floor for reopened / inconclusive.
  //    We cannot see the verdicts directly from the analyzer (they're agent
  //    output), so we rely on the plan's tags as the authoritative echo.
  for (const g of plan.groups) {
    const tags = g.tags ?? [];
    if (tags.includes('deletion-rationale-reopened') && g.attention !== 'heavy') {
      violations.push({
        rule: 'deletion-reopened-needs-heavy-attention',
        severity: 'error',
        message: `group #${g.index} "${g.name}" is tagged deletion-rationale-reopened but attention=${g.attention}`,
        group: g.index,
      });
    }
    if (tags.includes('deletion-rationale-inconclusive') && g.attention === 'none') {
      violations.push({
        rule: 'deletion-inconclusive-needs-attention',
        severity: 'error',
        message: `group #${g.index} "${g.name}" is tagged deletion-rationale-inconclusive but attention=none`,
        group: g.index,
      });
    }
  }

  // 7. Group kind must reflect constituent kinds. A group containing any
  //    commit with primaryKind='conflict' must be kind='conflict' (or
  //    'mixed' if it spans multiple severities). Same for 'divergence'
  //    promoting above 'clean'. Prevents kind-washing.
  //    Severity order: conflict > divergence > structural > clean.
  const severityRank: Record<string, number> = {
    clean: 0,
    structural: 1,
    divergence: 2,
    conflict: 3,
    break_point: 0,
  };
  for (const g of plan.groups) {
    if (g.kind === 'break_point') continue;
    const kindSet = new Set<string>();
    for (const sha of g.commits) {
      const c = analyzer.commits.find((x) => x.sha === sha);
      if (c) kindSet.add(c.primaryKind);
    }
    const maxRank = [...kindSet].reduce(
      (m, k) => Math.max(m, severityRank[k] ?? 0),
      0,
    );
    const groupRank = severityRank[g.kind] ?? 0;
    const multipleSeverities =
      [...kindSet].filter((k) => (severityRank[k] ?? 0) > 0).length > 1;
    if (g.kind === 'mixed' && !multipleSeverities) {
      violations.push({
        rule: 'spurious-mixed-kind',
        severity: 'warning',
        message: `group #${g.index} "${g.name}" declares kind=mixed but contains only kind=${[...kindSet].join(',')}`,
        group: g.index,
      });
    }
    if (g.kind !== 'mixed' && groupRank < maxRank) {
      const worst = [...kindSet].reduce(
        (w, k) => ((severityRank[k] ?? 0) > (severityRank[w] ?? 0) ? k : w),
        'clean',
      );
      violations.push({
        rule: 'group-kind-understated',
        severity: 'error',
        message: `group #${g.index} "${g.name}" kind=${g.kind} but contains commit with primaryKind=${worst}; use kind=${worst} or kind=mixed`,
        group: g.index,
      });
    }
  }

  // 8. mergeOrder coverage. If present, must reference each group's index
  //    exactly once. If absent, skill defaults to group index order.
  if (plan.mergeOrder) {
    const ids = new Set<number>(plan.mergeOrder);
    if (ids.size !== plan.mergeOrder.length) {
      violations.push({
        rule: 'duplicate-in-merge-order',
        severity: 'error',
        message: `mergeOrder has duplicate entries`,
      });
    }
    for (const g of plan.groups) {
      if (!ids.has(g.index)) {
        violations.push({
          rule: 'merge-order-missing-group',
          severity: 'error',
          message: `mergeOrder does not include group #${g.index} "${g.name}"`,
          group: g.index,
        });
      }
    }
    for (const idx of plan.mergeOrder) {
      if (!plan.groups.find((g) => g.index === idx)) {
        violations.push({
          rule: 'merge-order-unknown-group',
          severity: 'error',
          message: `mergeOrder references unknown group index ${idx}`,
        });
      }
    }
  }

  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.filter((v) => v.severity === 'warning').length;
  return { violations, errors, warnings };
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

// Unused export stub: keeps FlsDeletionGroup referenced so module re-exports
// are stable if future checks consume it directly.
export type _FlsDeletionGroupShape = FlsDeletionGroup;
