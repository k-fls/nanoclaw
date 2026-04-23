// 4-part version derivation (read-only in Phase 0).
// Implements cascade/docs/versioning.md.
//
// A branch's version is A.B.C.D where:
//   - A.B.C is inherited from the version source (3 parts, per config.yaml
//     `version_depth`).
//   - D is the per-branch counter, read from the branch's most recent tag
//     `<branch>/<A.B.C.D>`. If no such tag exists, D = 0.
//
// Phase 0 does not auto-bump or write tags. Full logic lands in Phase 2.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import YAML from 'yaml';
import {
  BranchClass,
  classOf,
  git,
  gitOk,
  listAllBranches,
  loadRegistry,
  versionSourceOf,
} from './branch-graph.js';

export interface Version {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface VersionReport {
  branch: string;
  version: Version | null;
  prefixSource: string;
  prefixSourceVersion: Version | null;
  notes: string[];
}

export interface RepoConfig {
  version_depth: number;
  upstream_remote: string;
  upstream_main_branch: string;
  // P1 "discarded" inspection threshold: flag a target-discarded file only
  // when upstream's in-range delta on it (added + removed lines) exceeds
  // this. Low floor is right — a small bugfix on a discarded file can still
  // be worth reviewing. Default 10.
  discarded_min_delta_lines: number;
  // P1 "introduced" inspection threshold: flag an upstream-introduced file
  // the target never had only when its size on source tip exceeds this many
  // lines. Higher floor is right — small new files (stubs, gitkeeps) rarely
  // need adoption review. Default 50.
  introduced_min_file_lines: number;
  // Whether the analyzer computes the whitespace-only per-file signal used
  // by the attention-floor exemption. Default true. Set false for projects
  // where whitespace is semantic (Python, YAML, Makefiles, shell heredocs):
  // a reformat there can change behavior and must not be silently exempted.
  intake_whitespace_only: boolean;
  // P2 hotfix-loop-open check: days between a deploy cherry-pick landing and
  // the propagated core merge closing the pair before the warning fires.
  // Grep scope on deploy tips is capped at warn_days × 2.
  hotfix_loop_warn_days: number;
  // Downstream-role marker. Present only in downstream-repo configs; the
  // presence of `downstream.source_remote` is itself the "this repo is a
  // downstream" signal. Source-repo configs omit it.
  downstream: { source_remote: string } | null;
}

const DEFAULTS = {
  discarded_min_delta_lines: 10,
  introduced_min_file_lines: 50,
  intake_whitespace_only: true,
  hotfix_loop_warn_days: 14,
};

// Git remote name: letters/digits, optional dot/underscore/dash, no slash, no
// whitespace. Catches accidents like "source,other" or trailing spaces at
// load time rather than at fetch time.
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Branch-class prefixes that cannot coexist with downstream.source_remote in
// a single repo. Deliberately excludes core/main (every repo has a default
// branch) and upstream/* (read-only).
const SOURCE_COMPOSITION_PATTERNS = [
  /^channel\//,
  /^skill\//,
  /^module\//,
  /^edition\//,
];

export class RoleConflictError extends Error {
  kind = 'role-conflict' as const;
  constructor(
    public sourceRemote: string,
    public offendingBranches: string[],
  ) {
    super(
      `role-conflict: downstream.source_remote="${sourceRemote}" set, but local source-composition branches exist: ${offendingBranches.join(', ')}`,
    );
  }
}

function localBranches(repoRoot: string): string[] {
  const out = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  return out ? out.split('\n') : [];
}

function assertRepoRole(config: RepoConfig, repoRoot: string): void {
  if (!config.downstream) return;
  const locals = localBranches(repoRoot);
  const offenders = locals.filter((b) =>
    SOURCE_COMPOSITION_PATTERNS.some((re) => re.test(b)),
  );
  if (offenders.length > 0) {
    throw new RoleConflictError(config.downstream.source_remote, offenders);
  }
}

const KNOWN_CONFIG_KEYS = new Set<string>([
  'version_depth',
  'upstream_remote',
  'upstream_main_branch',
  'discarded_min_delta_lines',
  'introduced_min_file_lines',
  'intake_whitespace_only',
  'hotfix_loop_warn_days',
  'downstream',
]);

export interface LoadConfigOptions {
  // Skip the role-conflict check. Used only by tests and tools that want the
  // parsed config without a repo-state assertion (e.g. migration scripts).
  skipRoleCheck?: boolean;
}

export function loadConfig(repoRoot: string, opts: LoadConfigOptions = {}): RepoConfig {
  const file = path.join(repoRoot, '.cascade', 'config.yaml');
  const parsed = YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${file}: not a YAML object`);
  }
  // Fail-loud on unknown keys — a typo in `downstream:` (say `downsteam:`)
  // should not silently mean "not a downstream repo".
  for (const k of Object.keys(parsed)) {
    if (!KNOWN_CONFIG_KEYS.has(k)) {
      throw new Error(`${file}: unknown key "${k}"`);
    }
  }
  if (
    typeof parsed.version_depth !== 'number' ||
    typeof parsed.upstream_remote !== 'string' ||
    typeof parsed.upstream_main_branch !== 'string'
  ) {
    throw new Error(`${file}: required keys missing or wrong type`);
  }

  const hotfix = parsed.hotfix_loop_warn_days;
  if (hotfix !== undefined && (typeof hotfix !== 'number' || !Number.isInteger(hotfix) || hotfix <= 0)) {
    throw new Error(`${file}: hotfix_loop_warn_days must be a positive integer`);
  }

  let downstream: RepoConfig['downstream'] = null;
  if (parsed.downstream !== undefined) {
    const d = parsed.downstream as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw new Error(`${file}: downstream must be an object`);
    }
    for (const k of Object.keys(d)) {
      if (k !== 'source_remote') {
        throw new Error(`${file}: unknown key under downstream: "${k}"`);
      }
    }
    if (typeof d.source_remote !== 'string') {
      throw new Error(`${file}: downstream.source_remote must be a string`);
    }
    if (!REMOTE_NAME_RE.test(d.source_remote)) {
      throw new Error(
        `${file}: downstream.source_remote "${d.source_remote}" is not a valid git remote name`,
      );
    }
    downstream = { source_remote: d.source_remote };
  }

  const config: RepoConfig = {
    version_depth: parsed.version_depth as number,
    upstream_remote: parsed.upstream_remote as string,
    upstream_main_branch: parsed.upstream_main_branch as string,
    discarded_min_delta_lines:
      (parsed.discarded_min_delta_lines as number | undefined) ??
      DEFAULTS.discarded_min_delta_lines,
    introduced_min_file_lines:
      (parsed.introduced_min_file_lines as number | undefined) ??
      DEFAULTS.introduced_min_file_lines,
    intake_whitespace_only:
      (parsed.intake_whitespace_only as boolean | undefined) ??
      DEFAULTS.intake_whitespace_only,
    hotfix_loop_warn_days:
      (parsed.hotfix_loop_warn_days as number | undefined) ??
      DEFAULTS.hotfix_loop_warn_days,
    downstream,
  };

  if (!opts.skipRoleCheck) assertRepoRole(config, repoRoot);
  return config;
}

export function formatVersion(v: Version): string {
  return `${v.a}.${v.b}.${v.c}.${v.d}`;
}

// Detect a prefix mismatch across multiple version sources being merged into a
// target. Implements the rule from cascade/docs/versioning.md § "Prefix
// derivation on merge".
//   - All sources share the same A.B.C → no mismatch.
//   - Sources disagree and `parent_branch` declares one of them → warning only
//     (mixed-version state is being produced deliberately).
//   - Sources disagree and no `parent_branch` → error.
export interface PrefixMismatch {
  severity: 'error' | 'warning' | 'ok';
  chosen: Version | null;
  message: string;
}

export function detectPrefixMismatch(
  target: string,
  sources: { name: string; version: Version }[],
  parentBranch: string | null,
): PrefixMismatch {
  if (sources.length === 0) {
    return { severity: 'ok', chosen: null, message: `${target}: no versioned sources` };
  }
  const first = sources[0].version;
  const allAgree = sources.every(
    (s) => s.version.a === first.a && s.version.b === first.b && s.version.c === first.c,
  );
  if (allAgree) {
    return {
      severity: 'ok',
      chosen: { a: first.a, b: first.b, c: first.c, d: 0 },
      message: `${target}: all sources share prefix ${first.a}.${first.b}.${first.c}`,
    };
  }
  const listed = sources
    .map((s) => `${s.name}=${s.version.a}.${s.version.b}.${s.version.c}`)
    .join(', ');
  if (parentBranch) {
    const chosen = sources.find((s) => s.name === parentBranch);
    if (!chosen) {
      return {
        severity: 'error',
        chosen: null,
        message: `${target}: parent_branch declares "${parentBranch}" but it is not among the versioned sources (${listed})`,
      };
    }
    return {
      severity: 'warning',
      chosen: { a: chosen.version.a, b: chosen.version.b, c: chosen.version.c, d: 0 },
      message: `${target}: prefix mismatch resolved via parent_branch "${parentBranch}" (${listed})`,
    };
  }
  return {
    severity: 'error',
    chosen: null,
    message: `${target}: prefix mismatch and no .cascade/parent_branch declared (sources: ${listed})`,
  };
}

export function compareVersion(a: Version, b: Version): number {
  if (a.a !== b.a) return a.a - b.a;
  if (a.b !== b.b) return a.b - b.b;
  if (a.c !== b.c) return a.c - b.c;
  return a.d - b.d;
}

// Parse `<branch>/A.B.C.D` given the expected branch prefix. Returns the
// 4-part numeric version or null if not matchable.
export function parseCascadeTag(tag: string, branchPrefix: string): Version | null {
  if (!tag.startsWith(branchPrefix + '/')) return null;
  const rest = tag.slice(branchPrefix.length + 1);
  const m = rest.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { a: +m[1], b: +m[2], c: +m[3], d: +m[4] };
}

// Parse an upstream-style tag like `v1.2.0` or `1.2.0`. Returns {a,b,c,d=0}
// or null.
export function parseUpstreamTag(tag: string): Version | null {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { a: +m[1], b: +m[2], c: +m[3], d: 0 };
}

// List all tags reachable from `rev` (branch tip).
function reachableTags(rev: string, repoRoot: string): string[] {
  if (!gitOk(['rev-parse', '--verify', rev], repoRoot)) return [];
  const out = git(['tag', '--merged', rev], repoRoot);
  return out ? out.split('\n') : [];
}

// Compare A.B.C only (ignore D). Returns sign.
export function comparePrefix(a: Version, b: Version): number {
  if (a.a !== b.a) return a.a - b.a;
  if (a.b !== b.b) return a.b - b.b;
  return a.c - b.c;
}

// Latest cascade tag for a given tag-prefix, reachable from `rev`.
function latestCascadeTag(tagPrefix: string, rev: string, repoRoot: string): Version | null {
  const tags = reachableTags(rev, repoRoot);
  let best: Version | null = null;
  for (const t of tags) {
    const v = parseCascadeTag(t, tagPrefix);
    if (!v) continue;
    if (best === null || compareVersion(v, best) > 0) best = v;
  }
  return best;
}

// Latest upstream-style tag reachable from `rev`.
function latestUpstreamTag(rev: string, repoRoot: string): Version | null {
  const tags = reachableTags(rev, repoRoot);
  let best: Version | null = null;
  for (const t of tags) {
    const v = parseUpstreamTag(t);
    if (!v) continue;
    if (best === null || compareVersion(v, best) > 0) best = v;
  }
  return best;
}

// Resolve the version-source name to an actual existing git ref. Handles the
// core ↔ main transitional alias: when `core` is the class-canonical name but
// the repo still uses `main`, fall back to `main` (same class per the
// registry).
function resolveSourceRef(
  source: string,
  registry: BranchClass[],
  repoRoot: string,
): string | null {
  if (gitOk(['rev-parse', '--verify', source], repoRoot)) return source;
  // Find an existing branch that matches the same class as `source`.
  try {
    const srcInfo = classOf(source, registry);
    for (const b of listAllBranches(repoRoot)) {
      if (b === source) continue;
      try {
        if (classOf(b, registry).class.name === srcInfo.class.name && gitOk(['rev-parse', '--verify', b], repoRoot)) {
          return b;
        }
      } catch {
        /* unclassifiable */
      }
    }
  } catch {
    /* source itself not classifiable */
  }
  return null;
}

// Prefix A.B.C of the version source.
//
// Resolution order:
//   1. Latest cascade tag on the source itself (`<source>/A.B.C.D`). Its A.B.C
//      is the prefix.
//   2. Bootstrap fallback — no cascade tags yet: recursively compute the
//      source's own version via its version source (upstream at the bottom).
//      Its first three parts form this prefix.
function prefixFromSource(
  source: string,
  repoRoot: string,
  config: RepoConfig,
  registry: BranchClass[],
  seen: Set<string>,
): Version | null {
  if (seen.has(source)) {
    throw new Error(`cycle in version source chain: ${[...seen, source].join(' -> ')}`);
  }
  seen.add(source);

  const ref = resolveSourceRef(source, registry, repoRoot);
  if (!ref) return null;

  // Upstream branches use their own (non-cascade) tag namespace; those tags
  // ARE the source of truth.
  if (ref.startsWith(`${config.upstream_remote}/`) || ref.startsWith('upstream/')) {
    return latestUpstreamTag(ref, repoRoot);
  }

  // Prefer a cascade tag on the source if any exists.
  const fromTag =
    latestCascadeTag(source, ref, repoRoot) ?? latestCascadeTag(ref, ref, repoRoot);
  if (fromTag) return fromTag;

  // Bootstrap: no cascade tag yet on source → recurse to the source's own
  // version source. This is what makes `module/cascade` pick up `1.2.0` from
  // upstream through `main`/`core` even before the first cascade release.
  try {
    const grand = versionSourceOf(source, registry, repoRoot);
    const grandVersion = prefixFromSource(grand, repoRoot, config, registry, seen);
    if (grandVersion) {
      // D resets to 0 for the derived prefix; only A.B.C matters here.
      return { a: grandVersion.a, b: grandVersion.b, c: grandVersion.c, d: 0 };
    }
  } catch {
    /* source itself may be non-versioned or declared-but-missing; give up */
  }
  return null;
}

// ---------- D-bump planning (Phase 2) ----------

export class SourceTagMissingError extends Error {
  kind = 'source-tag-missing' as const;
  constructor(public branch: string, public source: string, public mergeBase: string) {
    super(
      `source-tag-missing: branch "${branch}" has no prior <branch>/* tag and no ${source} tag is reachable from merge-base ${mergeBase.slice(0, 12)}`,
    );
  }
}

export class NoPriorTagError extends Error {
  kind = 'no-prior-tag' as const;
  constructor(public branch: string) {
    super(
      `no-prior-tag: branch "${branch}" has no prior tag and no resolvable version source; supply --seed`,
    );
  }
}

export class SeedRejectedError extends Error {
  kind = 'seed-rejected' as const;
  constructor(public branch: string, public why: string) {
    super(`seed-rejected: --seed on "${branch}" is not allowed: ${why}`);
  }
}

export type BumpReason =
  | 'prefix-advanced'
  | 'target-advanced'
  | 'first-bump-from-baseline'
  | 'first-bump-from-seed';

export type BumpResult =
  | {
      kind: 'noop';
      reason: string;
      current: Version;
      sourcePrefix: Version;
    }
  | {
      kind: 'bump';
      next: Version;
      prior: Version | null;
      reason: BumpReason;
      sourcePrefix: Version | null;
    };

// Source is upstream-class (reads `vX.Y.Z` tags) iff its name starts with the
// configured upstream remote or the literal `upstream/` prefix.
function isUpstreamSource(source: string, config: RepoConfig): boolean {
  return (
    source.startsWith(`${config.upstream_remote}/`) || source.startsWith('upstream/')
  );
}

// Latest source-typed tag reachable from the given sha.
function latestSourceTagFrom(
  source: string,
  fromSha: string,
  repoRoot: string,
  config: RepoConfig,
): Version | null {
  if (isUpstreamSource(source, config)) return latestUpstreamTag(fromSha, repoRoot);
  return latestCascadeTag(source, fromSha, repoRoot);
}

function mergeBaseSha(a: string, b: string, repoRoot: string): string | null {
  try {
    const out = git(['merge-base', a, b], repoRoot);
    return out || null;
  } catch {
    return null;
  }
}

function tagCommit(tag: string, repoRoot: string): string | null {
  try {
    return git(['rev-list', '-n', '1', tag], repoRoot);
  } catch {
    return null;
  }
}

function branchTipSha(branch: string, repoRoot: string): string | null {
  if (!gitOk(['rev-parse', '--verify', branch], repoRoot)) return null;
  return git(['rev-parse', branch], repoRoot);
}

// First-bump baseline: walk the version source's tag history back to the
// merge-base between target and source. Returns the source's tag at that
// merge-base as the implied prior prefix (D=0). Null = no baseline derivable.
export function firstBumpBaseline(
  branch: string,
  repoRoot: string,
  registry: BranchClass[],
  config: RepoConfig,
):
  | { kind: 'ok'; baseline: Version; source: string; mergeBase: string }
  | { kind: 'source-unresolvable'; source: string }
  | { kind: 'no-merge-base'; source: string; sourceRef: string }
  | { kind: 'source-tag-missing'; source: string; mergeBase: string } {
  let source: string;
  try {
    source = versionSourceOf(branch, registry, repoRoot);
  } catch {
    // e.g. edition with no .cascade/parent_branch declared. Unresolvable by
    // definition; the caller decides whether to demand --seed or surface the
    // underlying error.
    return { kind: 'source-unresolvable', source: '(undeclared)' };
  }
  const sourceRef = resolveSourceRef(source, registry, repoRoot);
  if (!sourceRef) return { kind: 'source-unresolvable', source };

  const branchTip = branchTipSha(branch, repoRoot);
  if (!branchTip) {
    // Target branch doesn't exist yet as a ref. Treat as unresolvable
    // baseline — operator must seed.
    return { kind: 'source-unresolvable', source };
  }
  const mb = mergeBaseSha(branch, sourceRef, repoRoot);
  if (!mb) return { kind: 'no-merge-base', source, sourceRef };

  const baseline = latestSourceTagFrom(source, mb, repoRoot, config);
  if (!baseline) return { kind: 'source-tag-missing', source, mergeBase: mb };
  // Baseline D is implied 0, per spec. Clamp regardless of what the source tag's
  // D happened to be — the baseline is the *prefix* from that point.
  return {
    kind: 'ok',
    baseline: { a: baseline.a, b: baseline.b, c: baseline.c, d: 0 },
    source,
    mergeBase: mb,
  };
}

export interface PlanBumpOptions {
  seed?: Version;
  registry?: BranchClass[];
  config?: RepoConfig;
}

// Core D-bump planner. Pure in the sense that it reads but never writes git
// state; the call site (cascade tag, propagate.ts) decides whether to invoke
// writeTag().
export function planBump(
  branch: string,
  repoRoot: string,
  opts: PlanBumpOptions = {},
): BumpResult {
  const registry = opts.registry ?? loadRegistry(repoRoot);
  const config = opts.config ?? loadConfig(repoRoot);
  const info = classOf(branch, registry);
  if (info.class.fallback) {
    throw new Error(`planBump: ephemeral branch "${branch}" cannot be tagged`);
  }
  if (info.class.read_only) {
    throw new Error(`planBump: read-only branch "${branch}" cannot be tagged`);
  }
  if (info.class.not_versioned) {
    throw new Error(`planBump: branch "${branch}" is not versioned`);
  }

  const prior = latestCascadeTag(branch, branch, repoRoot);

  // Seed path.
  if (opts.seed) {
    if (prior) {
      throw new SeedRejectedError(branch, `prior tag ${branch}/${formatVersion(prior)} exists`);
    }
    const baseline = firstBumpBaseline(branch, repoRoot, registry, config);
    if (baseline.kind === 'ok') {
      throw new SeedRejectedError(
        branch,
        `baseline derivable from ${baseline.source} at merge-base ${baseline.mergeBase.slice(0, 12)}`,
      );
    }
    // source-unresolvable / no-merge-base / source-tag-missing all accept --seed.
    return {
      kind: 'bump',
      next: { ...opts.seed },
      prior: null,
      reason: 'first-bump-from-seed',
      sourcePrefix: null,
    };
  }

  // First-bump, no seed.
  if (!prior) {
    const baseline = firstBumpBaseline(branch, repoRoot, registry, config);
    if (baseline.kind === 'source-unresolvable' || baseline.kind === 'no-merge-base') {
      throw new NoPriorTagError(branch);
    }
    if (baseline.kind === 'source-tag-missing') {
      throw new SourceTagMissingError(branch, baseline.source, baseline.mergeBase);
    }
    // ok: first bump produces (baseline-prefix, D=1). Spec invariant: a
    // first-bump prefix can never exceed the source's tag at the merge-base.
    return {
      kind: 'bump',
      next: {
        a: baseline.baseline.a,
        b: baseline.baseline.b,
        c: baseline.baseline.c,
        d: 1,
      },
      prior: null,
      reason: 'first-bump-from-baseline',
      sourcePrefix: baseline.baseline,
    };
  }

  // Subsequent bump. Compare source-current-prefix vs prior-prefix.
  let source: string | null;
  try {
    source = versionSourceOf(branch, registry, repoRoot);
  } catch {
    source = null;
  }
  const sourceRef = source ? resolveSourceRef(source, registry, repoRoot) : null;
  const sourcePrefix =
    source && sourceRef
      ? latestSourceTagFrom(source, sourceRef, repoRoot, config)
      : null;

  if (!sourcePrefix) {
    // Source unresolvable or no tags visible. Conservatively noop — we can't
    // prove anything advanced.
    return {
      kind: 'noop',
      reason: `no source tag visible on "${source ?? '(undeclared)'}"; nothing to bump`,
      current: prior,
      sourcePrefix: prior,
    };
  }

  const prefixCmp = comparePrefix(sourcePrefix, prior);
  if (prefixCmp > 0) {
    return {
      kind: 'bump',
      next: { a: sourcePrefix.a, b: sourcePrefix.b, c: sourcePrefix.c, d: 1 },
      prior,
      reason: 'prefix-advanced',
      sourcePrefix,
    };
  }

  if (prefixCmp === 0) {
    // Same prefix. Bump D iff target has moved since the prior tag.
    const priorTagName = `${branch}/${formatVersion(prior)}`;
    const priorCommit = tagCommit(priorTagName, repoRoot);
    const branchTip = branchTipSha(branch, repoRoot);
    if (priorCommit && branchTip && priorCommit !== branchTip) {
      return {
        kind: 'bump',
        next: { a: prior.a, b: prior.b, c: prior.c, d: prior.d + 1 },
        prior,
        reason: 'target-advanced',
        sourcePrefix,
      };
    }
    return {
      kind: 'noop',
      reason: `branch "${branch}" is at prior tag ${priorTagName} and prefix unchanged`,
      current: prior,
      sourcePrefix,
    };
  }

  // Source prefix < prior prefix. Shouldn't happen in normal flow. Noop
  // rather than bump backwards; leaves a paper trail for a human to notice.
  return {
    kind: 'noop',
    reason: `source prefix ${formatVersion(sourcePrefix)} is behind prior ${formatVersion(prior)}; refusing to regress`,
    current: prior,
    sourcePrefix,
  };
}

export function computeVersion(
  branch: string,
  repoRoot: string,
  opts?: { registry?: BranchClass[]; config?: RepoConfig },
): VersionReport {
  const registry = opts?.registry ?? loadRegistry(repoRoot);
  const config = opts?.config ?? loadConfig(repoRoot);
  const info = classOf(branch, registry);
  const notes: string[] = [];

  if (info.class.fallback || info.class.read_only || info.class.not_versioned) {
    notes.push(`branch "${branch}" is not versioned (class=${info.class.name})`);
    return {
      branch,
      version: null,
      prefixSource: '',
      prefixSourceVersion: null,
      notes,
    };
  }

  const source = versionSourceOf(branch, registry, repoRoot);
  const sourceVersion = prefixFromSource(source, repoRoot, config, registry, new Set([branch]));
  if (!sourceVersion) {
    notes.push(`version source "${source}" has no recognizable tag; prefix unknown`);
    return {
      branch,
      version: null,
      prefixSource: source,
      prefixSourceVersion: null,
      notes,
    };
  }
  const branchTag = latestCascadeTag(branch, branch, repoRoot);
  const d = branchTag ? branchTag.d : 0;
  if (!branchTag) {
    notes.push(`no "${branch}/A.B.C.D" tag yet; D=0`);
  }
  return {
    branch,
    version: { a: sourceVersion.a, b: sourceVersion.b, c: sourceVersion.c, d },
    prefixSource: source,
    prefixSourceVersion: sourceVersion,
    notes,
  };
}
