// CI entry point. Runs all Phase 0 checks. Exit codes:
//   0 — clean, or only bypassed violations
//   1 — at least one non-bypassed violation
//   2 — warnings only (returned only with --strict)
// See cascade/docs/phase-0.md § Done criteria.

import {
  BranchClass,
  classOf,
  git,
  gitOk,
  isLongLived,
  listAllBranches,
  loadRegistry,
} from './branch-graph.js';
import {
  deriveOwnership,
  formatOwnershipMap,
  writeOwnershipMap,
} from './ownership.js';
import { readBypassLog, validateEntry, BypassEntry } from './bypass.js';
import { detectPrefixMismatch, loadConfig } from './version.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Violation {
  rule: string;
  severity: Severity;
  message: string;
  // Commit(s) the violation is attached to. Usually a single-element list
  // (e.g. squash marker on one commit); double-introduction lists several.
  // An `upstream/*` policy bypass matches iff at least one commit here is
  // upstream-reachable.
  commits?: string[];
}

export interface CheckResult {
  violations: Violation[];
  bypassed: Violation[];
  errors: number;
  warnings: number;
  infos: number;
}

export interface CheckOptions {
  repoRoot: string;
  writeMap?: boolean; // also write /.ownership_map.txt
  json?: boolean;
  strict?: boolean;
}

export function runCheck(opts: CheckOptions): CheckResult {
  const { repoRoot } = opts;
  const registry = loadRegistry(repoRoot);
  const violations: Violation[] = [];

  // 1. Ownership determinism + map generation.
  const first = deriveOwnership({ repoRoot, registry });
  const second = deriveOwnership({ repoRoot, registry });
  const firstText = formatOwnershipMap(first);
  const secondText = formatOwnershipMap(second);
  if (firstText !== secondText) {
    violations.push({
      rule: 'determinism',
      severity: 'error',
      message: 'ownership derivation is non-deterministic: two consecutive runs produced different output',
    });
  }
  if (opts.writeMap) writeOwnershipMap(repoRoot, first);

  // 2. Dead ownership rules (info). A dead rule is expected for safety-net
  //    patterns (nothing matches = nothing committed that shouldn't be).
  for (const pat of first.deadRules) {
    violations.push({
      rule: 'dead-rule',
      severity: 'info',
      message: `ownership_rules pattern "${pat}" matched no committed file`,
    });
  }

  // 2b. Hygiene: safety-net pattern matched a committed file — something that
  //     shouldn't be tracked IS tracked. Real warning.
  for (const h of first.hygieneViolations) {
    violations.push({
      rule: 'hygiene',
      severity: 'warning',
      message: `${h.path}: matches safety-net pattern "${h.pattern}" but is committed`,
    });
  }

  // 3. Double introductions. Pre-registry ephemerals produce benign ones,
  //    so the check is a warning when all introducers are on ephemerals or
  //    otherwise unclassifiable; an error only when an independent
  //    introduction appears on a long-lived branch.
  for (const di of first.doubleIntroductions) {
    const severity = doubleIntroductionSeverity(di.commits, registry, repoRoot);
    violations.push({
      rule: 'double-introduction',
      severity,
      message: `${di.path}: introduced by ${di.commits.length} independent commits (${di.commits.map((c) => c.slice(0, 7)).join(', ')})`,
      commits: di.commits,
    });
  }

  // 4. Unowned files (error per §9: "requires an explicit ownership decision").
  for (const p of first.unowned) {
    violations.push({
      rule: 'unowned',
      severity: 'error',
      message: `${p}: no long-lived branch contains the introducing commit; explicit ownership decision needed`,
    });
  }

  // 4b. Invalid ownership overrides (error — a typo or stale branch name is
  //     silently ignoring the user's intent).
  for (const io of first.invalidOverrides) {
    violations.push({
      rule: 'override-invalid',
      severity: 'error',
      message: `${io.path}: ownership_overrides entry names invalid owner "${io.owner}" (${io.reason})`,
    });
  }
  // 4c. Redundant overrides — derivation already agrees; the entry is noise.
  //     Info-level; visible with --verbose.
  for (const ro of first.redundantOverrides) {
    violations.push({
      rule: 'override-redundant',
      severity: 'info',
      message: `${ro.path}: override declares owner "${ro.owner}" but derivation already produces the same result — safe to remove`,
    });
  }

  // 5. Base validity. Every long-lived branch must share history with its
  //    class-declared base. We intentionally do NOT require the base to be a
  //    current ancestor — upstream → core, for instance, is expected to
  //    diverge between intakes. "Shares history" (non-empty merge-base) is
  //    the strongest claim we can make here; stronger invariants (e.g. the
  //    cut point sits on the base branch) require tag discipline P1 introduces.
  const seenBranches = new Set<string>();
  for (const branch of listAllBranches(repoRoot)) {
    if (seenBranches.has(branch)) continue;
    seenBranches.add(branch);
    let info;
    try {
      info = classOf(branch, registry);
    } catch {
      continue;
    }
    if (!isLongLived(info)) continue;
    const baseSpec = info.class.base ?? info.class.base_from_match;
    if (!baseSpec) continue;
    const base = expandBase(info.class, info.match);
    if (!base) continue;
    if (base.includes('*')) continue;
    const baseRef = resolveBaseRef(base, registry, repoRoot);
    if (!baseRef) {
      violations.push({
        rule: 'base-validity',
        severity: 'warning',
        message: `${branch}: declared base "${base}" does not exist in the repo`,
      });
      continue;
    }
    try {
      const mb = git(['merge-base', baseRef, branch], repoRoot);
      if (!mb) {
        violations.push({
          rule: 'base-validity',
          severity: 'error',
          message: `${branch}: no merge-base with declared base "${base}"; branches share no history`,
        });
      }
    } catch {
      violations.push({
        rule: 'base-validity',
        severity: 'error',
        message: `${branch}: no merge-base with declared base "${base}"; branches share no history`,
      });
    }
  }

  // 6. Squash-merge markers on long-lived branches. Best-effort heuristic —
  //    FF cannot be detected post-hoc (that's a forge-level gate, per §5).
  for (const { branch, commit, subject } of recentCommitsOnLongLived(registry, repoRoot, 500)) {
    if (looksLikeSquash(subject)) {
      violations.push({
        rule: 'merge-preserve',
        severity: 'warning',
        message: `${branch}: commit ${commit.slice(0, 7)} looks like a squash merge ("${subject.slice(0, 60)}")`,
        commits: [commit],
      });
    }
  }

  // 7. bypass-log format + commit existence.
  let log: BypassEntry[] = [];
  try {
    log = readBypassLog(repoRoot);
    for (const e of log) validateEntry(e, repoRoot);
  } catch (e) {
    violations.push({
      rule: 'bypass-log',
      severity: 'error',
      message: (e as Error).message,
    });
  }

  // Commits reachable from the upstream ref. Used by `upstream/*` policy
  // entries in bypass-log (see cascade/docs/artifacts.md § bypass-log).
  const upstreamSet = loadUpstreamSet(repoRoot);

  // Apply bypass-log: move matching violations from errors to bypassed.
  const { kept, bypassed } = applyBypass(violations, log, upstreamSet);

  const errors = kept.filter((v) => v.severity === 'error').length;
  const warnings = kept.filter((v) => v.severity === 'warning').length;
  const infos = kept.filter((v) => v.severity === 'info').length;
  return { violations: kept, bypassed, errors, warnings, infos };
}

// Commits reachable from the upstream ref declared in .cascade/config.yaml.
// Empty set if the upstream ref doesn't exist locally (e.g. no fetch yet).
function loadUpstreamSet(repoRoot: string): Set<string> {
  let upstreamRef: string;
  try {
    const cfg = loadConfig(repoRoot);
    upstreamRef = `${cfg.upstream_remote}/${cfg.upstream_main_branch}`;
  } catch {
    return new Set();
  }
  if (!gitOk(['rev-parse', '--verify', upstreamRef], repoRoot)) return new Set();
  const out = git(['rev-list', upstreamRef], repoRoot);
  return new Set(out ? out.split('\n') : []);
}

// Resolve a declared base name to an actual existing ref. Handles the same
// core ↔ main transitional alias as version.ts: if the declared base doesn't
// exist but another branch in the same class does, use that.
function resolveBaseRef(
  base: string,
  registry: BranchClass[],
  repoRoot: string,
): string | null {
  if (gitOk(['rev-parse', '--verify', base], repoRoot)) return base;
  try {
    const baseInfo = classOf(base, registry);
    for (const b of listAllBranches(repoRoot)) {
      if (b === base) continue;
      try {
        if (
          classOf(b, registry).class.name === baseInfo.class.name &&
          gitOk(['rev-parse', '--verify', b], repoRoot)
        ) {
          return b;
        }
      } catch {
        /* unclassifiable */
      }
    }
  } catch {
    /* base itself not classifiable */
  }
  return null;
}

function expandBase(cls: BranchClass, match: RegExpMatchArray): string | null {
  if (cls.base_from_match) {
    return cls.base_from_match.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');
  }
  return cls.base ?? null;
}

function applyBypass(
  violations: Violation[],
  log: BypassEntry[],
  upstreamSet: Set<string>,
): { kept: Violation[]; bypassed: Violation[] } {
  const kept: Violation[] = [];
  const bypassed: Violation[] = [];
  for (const v of violations) {
    const matched = log.some((e) => {
      if (e.rule !== v.rule) return false;
      if (e.commit === 'upstream/*') {
        // Policy entry: matches when *any* commit tied to this violation is
        // upstream-reachable. This is deliberately permissive so that
        // artifacts of upstream intake (e.g. a path re-introduced on an fls
        // "merged upstream" commit alongside the original upstream commit)
        // are suppressed along with pure-upstream violations. A violation
        // with no commits (dead-rule, base-validity, ...) never matches.
        if (!v.commits || v.commits.length === 0) return false;
        return v.commits.some((c) => upstreamSet.has(c));
      }
      // Standard entry: sha-prefix match against any attached commit. A
      // violation with no commits matches on rule alone.
      if (!v.commits || v.commits.length === 0) return true;
      return v.commits.some((c) => c.startsWith(e.commit));
    });
    if (matched) bypassed.push(v);
    else kept.push(v);
  }
  return { kept, bypassed };
}

function looksLikeSquash(subject: string): boolean {
  // GitHub's squash default: "<PR title> (#123)". Not a reliable signal; use a
  // stricter marker to cut false positives.
  if (/^Squashed commit of the following/i.test(subject)) return true;
  if (/\(squashed\)/i.test(subject)) return true;
  return false;
}

function recentCommitsOnLongLived(
  registry: BranchClass[],
  repoRoot: string,
  limit: number,
): { branch: string; commit: string; subject: string }[] {
  const out: { branch: string; commit: string; subject: string }[] = [];
  for (const branch of listAllBranches(repoRoot)) {
    let info;
    try {
      info = classOf(branch, registry);
    } catch {
      continue;
    }
    if (!isLongLived(info)) continue;
    // Only inspect commits unique to this branch's first-parent history.
    try {
      const log = git(
        ['log', '--first-parent', `--max-count=${limit}`, '--format=%H%x09%s', branch],
        repoRoot,
      );
      if (!log) continue;
      for (const line of log.split('\n')) {
        const [commit, ...rest] = line.split('\t');
        if (!commit) continue;
        out.push({ branch, commit, subject: rest.join('\t') });
      }
    } catch {
      /* branch inaccessible */
    }
  }
  return out;
}

function doubleIntroductionSeverity(
  commits: string[],
  registry: BranchClass[],
  repoRoot: string,
): 'error' | 'warning' {
  // Error if any long-lived branch's first-parent chain contains two distinct
  // introducing commits for the same path. That would be a "same path
  // independently introduced on two long-lived timelines" case per §9.
  // Otherwise (pre-registry ephemeral noise) downgrade to warning.
  const longLived = listAllBranches(repoRoot).filter((b) => {
    try {
      return isLongLived(classOf(b, registry));
    } catch {
      return false;
    }
  });
  for (const b of longLived) {
    try {
      const fp = new Set(git(['log', '--first-parent', '--format=%H', b], repoRoot).split('\n'));
      let hits = 0;
      for (const c of commits) if (fp.has(c)) hits++;
      if (hits >= 2) return 'error';
    } catch {
      /* skip */
    }
  }
  return 'warning';
}

export interface FormatOptions {
  strict: boolean;
  verbose: boolean; // include info-level violations in the output
}

export function formatReport(r: CheckResult, opts: FormatOptions): string {
  const lines: string[] = [];
  for (const v of r.violations) {
    if (v.severity === 'info' && !opts.verbose) continue;
    lines.push(`[${v.severity}] ${v.rule}: ${v.message}`);
  }
  if (r.bypassed.length > 0 && opts.verbose) {
    lines.push('');
    lines.push(`bypassed (${r.bypassed.length}):`);
    for (const v of r.bypassed) {
      lines.push(`  - ${v.rule}: ${v.message}`);
    }
  }

  // Rot-protection notices: a handful of info rules get an always-visible
  // summary line even when --verbose isn't set, so latent hygiene issues
  // don't stay invisible forever. Individual entries remain at info.
  if (!opts.verbose) {
    const redundant = r.violations.filter((v) => v.rule === 'override-redundant').length;
    if (redundant > 0) {
      lines.push('');
      lines.push(
        `notice: ${redundant} override(s) appear redundant (derivation already agrees); run \`cascade check --verbose\` to list.`,
      );
    }
  }

  lines.push('');
  const hidden: string[] = [];
  if (!opts.verbose && r.infos > 0) hidden.push(`${r.infos} info`);
  if (!opts.verbose && r.bypassed.length > 0) hidden.push(`${r.bypassed.length} bypassed`);
  const hiddenNote = hidden.length > 0 ? ` (${hidden.join(', ')} hidden; use --verbose)` : '';
  lines.push(
    `summary: ${r.errors} error(s), ${r.warnings} warning(s), ${r.bypassed.length} bypassed${hiddenNote}`,
  );
  if (r.errors > 0) lines.push('→ FAIL');
  else if (r.warnings > 0 && opts.strict) lines.push('→ FAIL (warnings, --strict)');
  else lines.push('→ OK');
  return lines.join('\n');
}

export function exitCodeFor(r: CheckResult, strict: boolean): number {
  if (r.errors > 0) return 1;
  if (r.warnings > 0 && strict) return 2;
  return 0;
}

// Self-test fixture for the prefix-mismatch rule — exercises the rule with
// synthetic inputs, so it's verified without waiting for real editions.
// Phase-0 done-criterion: cascade/docs/phase-0.md § Done criteria.
export function runSelfTest(): { passed: number; failed: { name: string; reason: string }[] } {
  const failed: { name: string; reason: string }[] = [];
  let passed = 0;

  const cases: {
    name: string;
    target: string;
    sources: { name: string; version: { a: number; b: number; c: number; d: number } }[];
    parent: string | null;
    expectSeverity: 'error' | 'warning' | 'ok';
  }[] = [
    {
      name: 'all sources agree → ok',
      target: 'edition/starter',
      sources: [
        { name: 'core', version: { a: 1, b: 9, c: 0, d: 5 } },
        { name: 'channel/whatsapp', version: { a: 1, b: 9, c: 0, d: 3 } },
      ],
      parent: null,
      expectSeverity: 'ok',
    },
    {
      name: 'disagree + no parent_branch → error',
      target: 'edition/starter',
      sources: [
        { name: 'core', version: { a: 1, b: 9, c: 0, d: 5 } },
        { name: 'channel/whatsapp', version: { a: 1, b: 8, c: 0, d: 3 } },
      ],
      parent: null,
      expectSeverity: 'error',
    },
    {
      name: 'disagree + parent_branch declared → warning',
      target: 'edition/starter',
      sources: [
        { name: 'core', version: { a: 1, b: 9, c: 0, d: 5 } },
        { name: 'channel/whatsapp', version: { a: 1, b: 8, c: 0, d: 3 } },
      ],
      parent: 'core',
      expectSeverity: 'warning',
    },
    {
      name: 'parent_branch names a non-source → error',
      target: 'edition/starter',
      sources: [
        { name: 'core', version: { a: 1, b: 9, c: 0, d: 5 } },
        { name: 'channel/whatsapp', version: { a: 1, b: 8, c: 0, d: 3 } },
      ],
      parent: 'module/nowhere',
      expectSeverity: 'error',
    },
  ];

  for (const c of cases) {
    const r = detectPrefixMismatch(c.target, c.sources, c.parent);
    if (r.severity !== c.expectSeverity) {
      failed.push({
        name: c.name,
        reason: `expected severity="${c.expectSeverity}", got "${r.severity}" (${r.message})`,
      });
    } else {
      passed++;
    }
  }

  return { passed, failed };
}
