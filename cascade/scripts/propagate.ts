// Propagation planner (Phase 2 — Step 3: dry-run only).
//
// Computes the merge sequence per cascade/docs/versioning.md § "Propagation
// order implied by prefix rule". This script is the *planner*; execution
// lives in Step 4.
//
// Determinism contract (phase-2.md § Done criteria): two consecutive
// `cascade propagate --dry-run --json` invocations against a fixed repo
// state must produce byte-identical output. No wall-clock, no HEAD-at-
// invocation SHAs in the planner output, stable object-key order.

import { execFileSync } from 'node:child_process';
import {
  BranchClass,
  classOf,
  git,
  gitOk,
  isLongLived,
  listAllBranches,
  loadRegistry,
  versionSourceOf,
} from './branch-graph.js';
import {
  BumpReason,
  NoPriorTagError,
  RepoConfig,
  SourceTagMissingError,
  Version,
  formatVersion,
  loadConfig,
  planBump,
} from './version.js';
import { mergePreserve } from './merge-preserve.js';
import { TagExistsError, writeTag } from './tags.js';
import { computeSnapshot } from './edition-snapshot.js';

export type HopStatus = 'done' | 'pending' | 'would-halt';

export interface Hop {
  hop: string; // "source -> target"
  source: string;
  target: string;
  status: HopStatus;
  // Set when status === 'would-halt'. Drawn from the halt registry.
  halt_kind?: string;
  halt_reason?: string;
  // Predicted tag name post-bump, e.g. "channel/telegram/1.9.0.1". Null when
  // status is 'done' or 'would-halt' without a clear target version.
  predicted_tag: string | null;
  predicted_version: string | null;
  bump_reason?: BumpReason | null;
  // Name of another hop whose halt blocks this one. Null for independent
  // hops and for hops not currently blocked.
  blocked_by: string | null;
}

export interface PreflightHalt {
  kind: string;
  message: string;
  remediation: string;
}

export interface PropagationPlan {
  // Null when a pre-flight refusal occurred (hops empty in that case).
  preflight_halt: PreflightHalt | null;
  hops: Hop[];
}

export interface PlanOptions {
  repoRoot: string;
  noFetch?: boolean;
  registry?: BranchClass[];
  config?: RepoConfig;
}

// ---------- pre-flight ----------

function workingTreeDirty(repoRoot: string): string[] {
  // `git status --porcelain` with no MERGE_HEAD present. MERGE_HEAD is a
  // separate signal (stale-merge / merge-in-progress) handled by the
  // execution loop, not here.
  try {
    const out = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.trim() ? out.trim().split('\n') : [];
  } catch {
    return [];
  }
}

function tryFetch(remote: string, repoRoot: string): { ok: true } | { ok: false; error: string } {
  try {
    execFileSync('git', ['fetch', remote, '--tags'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function remoteExists(remote: string, repoRoot: string): boolean {
  try {
    execFileSync('git', ['remote', 'get-url', remote], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function preflight(opts: PlanOptions, config: RepoConfig): PreflightHalt | null {
  const { repoRoot, noFetch } = opts;

  // role-conflict was already raised inside loadConfig(); reaching here
  // means that check passed.

  // Fetch. Downstream mode fetches its configured source_remote; source
  // mode fetches upstream_remote.
  if (!noFetch) {
    const remote = config.downstream?.source_remote ?? config.upstream_remote;
    if (!remoteExists(remote, repoRoot)) {
      // Downstream repos raise remote-missing; source repos just swallow
      // (upstream remote absent in many local checkouts is expected).
      if (config.downstream) {
        return {
          kind: 'remote-missing',
          message: `downstream remote "${remote}" is not configured`,
          remediation: `git remote add ${remote} <url>`,
        };
      }
    } else {
      const f = tryFetch(remote, repoRoot);
      if (!f.ok) {
        return {
          kind: 'fetch-failed',
          message: `fetch ${remote} --tags failed: ${f.error}`,
          remediation: 'resolve network or credentials, or pass --no-fetch',
        };
      }
    }
  }

  const dirty = workingTreeDirty(repoRoot);
  if (dirty.length > 0) {
    return {
      kind: 'bad-state',
      message: `working tree is dirty (${dirty.length} entry/entries)`,
      remediation: 'clean or stash, then re-run',
    };
  }

  return null;
}

// ---------- plan enumeration ----------

interface RawHop {
  source: string;
  target: string;
}

function isAncestor(a: string, b: string, repoRoot: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// For an edition target, find every channel/skill/adapter branch whose tip
// is an ancestor of the edition tip. These are the edition's "included"
// sources alongside core.
function editionSources(
  branch: string,
  registry: BranchClass[],
  repoRoot: string,
): string[] {
  const sources: string[] = [];
  if (!gitOk(['rev-parse', '--verify', branch], repoRoot)) return sources;
  for (const b of listAllBranches(repoRoot)) {
    if (b === branch) continue;
    let info;
    try {
      info = classOf(b, registry);
    } catch {
      continue;
    }
    if (!['channel', 'skill', 'skill-adapter', 'module-adapter'].includes(info.class.name)) {
      continue;
    }
    if (!gitOk(['rev-parse', '--verify', b], repoRoot)) continue;
    if (isAncestor(b, branch, repoRoot)) sources.push(b);
  }
  return sources;
}

// Resolve a deploy's edition ancestor. Uses `version_source_from_ancestry`
// declared on the deploy class.
function deployEdition(
  branch: string,
  registry: BranchClass[],
  repoRoot: string,
): string | null {
  try {
    return versionSourceOf(branch, registry, repoRoot);
  } catch {
    return null;
  }
}

// Resolve the core-class canonical branch — the repo might use `main`, or
// have both during the transitional period. Prefer literal "core", then
// "main", then any other core-class match.
function coreRef(registry: BranchClass[], repoRoot: string): string | null {
  const candidates: string[] = [];
  for (const b of listAllBranches(repoRoot)) {
    try {
      if (classOf(b, registry).class.name === 'core') candidates.push(b);
    } catch {
      /* ignore */
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.includes('core')) return 'core';
  if (candidates.includes('main')) return 'main';
  return candidates[0];
}

// Resolve a registry-declared source name (e.g. "core") to the actual branch
// that plays that role in this repo (e.g. "main" during transition).
function canonicalSourceName(
  source: string,
  registry: BranchClass[],
  repoRoot: string,
): string {
  if (source === 'core') {
    const c = coreRef(registry, repoRoot);
    if (c) return c;
  }
  return source;
}

function enumerateHops(
  registry: BranchClass[],
  config: RepoConfig,
  repoRoot: string,
): RawHop[] {
  const hops: RawHop[] = [];
  const core = coreRef(registry, repoRoot);

  for (const branch of listAllBranches(repoRoot)) {
    let info;
    try {
      info = classOf(branch, registry);
    } catch {
      continue;
    }
    if (!isLongLived(info)) continue;
    if (info.class.name === 'core') {
      // Only emit the upstream → core hop for the canonical core branch.
      // Fixture repos and transitional states may have both `core` and
      // `main` as core-class; a duplicate hop would break plan shape.
      if (branch !== core) continue;
      if (!config.downstream) {
        const upstream = `${config.upstream_remote}/${config.upstream_main_branch}`;
        if (gitOk(['rev-parse', '--verify', upstream], repoRoot)) {
          hops.push({ source: upstream, target: branch });
        }
      }
      continue;
    }

    if (info.class.name === 'edition') {
      if (core) hops.push({ source: core, target: branch });
      for (const s of editionSources(branch, registry, repoRoot)) {
        hops.push({ source: s, target: branch });
      }
      continue;
    }

    if (info.class.name === 'deploy') {
      const ed = deployEdition(branch, registry, repoRoot);
      if (ed) hops.push({ source: canonicalSourceName(ed, registry, repoRoot), target: branch });
      continue;
    }

    // channel / skill / module / skill-adapter / module-adapter — single
    // version source.
    try {
      const src = versionSourceOf(branch, registry, repoRoot);
      hops.push({
        source: canonicalSourceName(src, registry, repoRoot),
        target: branch,
      });
    } catch {
      /* unresolvable source (e.g. missing parent_branch on edition handled
         above); skip. */
    }
  }

  return hops;
}

// Topological level for stable-within-repo ordering. Lower levels come
// first (they are propagation sources for later levels).
const LEVEL = new Map<string, number>([
  ['upstream', 0],
  ['core', 1],
  ['module', 2],
  ['channel', 2],
  ['skill', 2],
  ['module-adapter', 3],
  ['skill-adapter', 3],
  ['edition', 4],
  ['deploy', 5],
]);

function levelOf(branch: string, registry: BranchClass[]): number {
  try {
    return LEVEL.get(classOf(branch, registry).class.name) ?? 99;
  } catch {
    return 99;
  }
}

function sortHops(hops: RawHop[], registry: BranchClass[]): RawHop[] {
  const keyed = hops.map((h) => ({
    h,
    targetLevel: levelOf(h.target, registry),
    target: h.target,
    coreSource: h.source.endsWith('/main') || h.source === 'core' || h.source === 'main' ? 0 : 1,
    source: h.source,
  }));
  keyed.sort((a, b) => {
    if (a.targetLevel !== b.targetLevel) return a.targetLevel - b.targetLevel;
    if (a.target !== b.target) return a.target < b.target ? -1 : 1;
    if (a.coreSource !== b.coreSource) return a.coreSource - b.coreSource;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
  return keyed.map((k) => k.h);
}

// ---------- plan build ----------

export function planPropagation(opts: PlanOptions): PropagationPlan {
  const registry = opts.registry ?? loadRegistry(opts.repoRoot);
  const config = opts.config ?? loadConfig(opts.repoRoot);

  const pre = preflight(opts, config);
  if (pre) return { preflight_halt: pre, hops: [] };

  const raw = sortHops(enumerateHops(registry, config, opts.repoRoot), registry);
  const hops: Hop[] = [];
  // Map target -> the halted hop whose resolution it needs.
  const haltByTarget = new Map<string, string>();
  // Map source -> the halted hop whose resolution it needs (for editions
  // whose sources are outputs of earlier hops).
  const haltBySource = new Map<string, string>();

  for (const rh of raw) {
    const hopName = `${rh.source} -> ${rh.target}`;
    // A hop is blocked when either its source or target is already the
    // subject of a halt earlier in plan order.
    const blocked =
      haltByTarget.get(rh.target) ?? haltBySource.get(rh.source) ?? null;

    // Compute planBump on target.
    let status: HopStatus = 'pending';
    let halt_kind: string | undefined;
    let halt_reason: string | undefined;
    let predicted_version: string | null = null;
    let predicted_tag: string | null = null;
    let bump_reason: BumpReason | null = null;

    try {
      const plan = planBump(rh.target, opts.repoRoot, { registry, config });
      if (plan.kind === 'noop') {
        status = 'done';
      } else {
        predicted_version = formatVersion(plan.next);
        predicted_tag = `${rh.target}/${predicted_version}`;
        bump_reason = plan.reason;
      }
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      if (err.kind === 'source-tag-missing' || err.kind === 'no-prior-tag') {
        status = 'would-halt';
        halt_kind = err.kind;
        halt_reason = err.message ?? '';
        haltByTarget.set(rh.target, hopName);
        haltBySource.set(rh.target, hopName);
      } else {
        throw e;
      }
    }

    hops.push({
      hop: hopName,
      source: rh.source,
      target: rh.target,
      status,
      halt_kind,
      halt_reason,
      predicted_tag,
      predicted_version,
      bump_reason,
      blocked_by: blocked,
    });
  }

  return { preflight_halt: null, hops };
}

// ---------- envelope shaping ----------

// Symmetric to artifacts.md § Halt envelope schema. `halted: null` + empty
// pending = clean run signature.
export interface HaltEnvelope {
  halted: {
    hop: string | null;
    kind: string;
    details: Record<string, unknown>;
    remediation: string;
  } | null;
  progress: {
    done: string[];
    pending: { hop: string; blocked_by: string | null }[];
  };
}

export function toEnvelope(plan: PropagationPlan): HaltEnvelope {
  if (plan.preflight_halt) {
    return {
      halted: {
        hop: null,
        kind: plan.preflight_halt.kind,
        details: { message: plan.preflight_halt.message },
        remediation: plan.preflight_halt.remediation,
      },
      progress: {
        done: [],
        pending: plan.hops.map((h) => ({ hop: h.hop, blocked_by: h.blocked_by })),
      },
    };
  }
  // Find the first would-halt, if any.
  const haltIdx = plan.hops.findIndex((h) => h.status === 'would-halt');
  const halted =
    haltIdx >= 0
      ? {
          hop: plan.hops[haltIdx].hop,
          kind: plan.hops[haltIdx].halt_kind ?? 'unknown',
          details: { message: plan.hops[haltIdx].halt_reason ?? '' },
          remediation: remediationFor(plan.hops[haltIdx].halt_kind ?? ''),
        }
      : null;

  const done = plan.hops.filter((h) => h.status === 'done').map((h) => h.hop);
  const pending = plan.hops
    .filter((h) => h.status !== 'done')
    .map((h) => ({ hop: h.hop, blocked_by: h.blocked_by }));

  return { halted, progress: { done, pending } };
}

function remediationFor(kind: string): string {
  switch (kind) {
    case 'source-tag-missing':
      return 'cascade tag <branch> --seed <A.B.C.D>';
    case 'no-prior-tag':
      return 'supply --seed <A.B.C.D>';
    case 'fetch-failed':
      return 'resolve network or credentials, or pass --no-fetch';
    case 'bad-state':
      return 'clean or stash the working tree, then re-run';
    case 'remote-missing':
      return 'git remote add <name> <url>';
    case 'role-conflict':
      return 'remove downstream.source_remote or delete stray composition branches';
    default:
      return '';
  }
}

// ---------- human renderer ----------

// ---------- executor ----------

export interface ExecuteOptions extends PlanOptions {
  // Session-scoped skip. Execution skips the hop whose target is `after` and
  // every hop whose blocked_by chain traces back to it. Independent siblings
  // still run. Nothing is persisted.
  after?: string;
}

export interface TagWrite {
  branch: string;
  tag: string;
  sha: string;
}

export interface ExecutionResult {
  halted: HaltEnvelope['halted'];
  tags_written: TagWrite[];
  progress: {
    done: string[];
    pending: { hop: string; blocked_by: string | null }[];
  };
  // Summary counts for the human renderer.
  summary: { advanced: number; halted: number; noop: number };
}

// Usage error sentinel (exit 2, no envelope).
export class AfterNoMatchError extends Error {
  constructor(public after: string) {
    super(`after-no-match: no halted hop targeting ${after}`);
  }
}

function mergeHeadPresent(repoRoot: string): boolean {
  return gitOk(['rev-parse', '--verify', 'MERGE_HEAD'], repoRoot);
}

function currentHeadSha(repoRoot: string): string {
  return git(['rev-parse', 'HEAD'], repoRoot);
}

function checkoutTarget(target: string, repoRoot: string): void {
  execFileSync('git', ['checkout', target], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tagShaIfAny(tag: string, repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-list', '-n', '1', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Evaluate MERGE_HEAD state against the current plan's source tip. Returns
// the halt kind or null. Per phase-2.md § Execution loop step 1:
//   - MERGE_HEAD reachable from source tip → merge-in-progress
//   - MERGE_HEAD not an ancestor of source tip → stale-merge
function inspectMergeHead(source: string, repoRoot: string): string | null {
  if (!mergeHeadPresent(repoRoot)) return null;
  const mergeHead = git(['rev-parse', 'MERGE_HEAD'], repoRoot);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', mergeHead, source], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return 'merge-in-progress';
  } catch {
    return 'stale-merge';
  }
}

interface ExecuteHopResult {
  kind: 'done' | 'wrote' | 'halt';
  tag?: TagWrite;
  halt?: { kind: string; message: string; details?: Record<string, unknown> };
}

function executeHop(
  source: string,
  target: string,
  registry: BranchClass[],
  config: RepoConfig,
  repoRoot: string,
): ExecuteHopResult {
  checkoutTarget(target, repoRoot);

  // MERGE_HEAD guard before anything else.
  const mh = inspectMergeHead(source, repoRoot);
  if (mh) {
    return {
      kind: 'halt',
      halt: {
        kind: mh,
        message:
          mh === 'merge-in-progress'
            ? `MERGE_HEAD present on ${target}; finish (git commit) or abort (git merge --abort), then re-run`
            : `MERGE_HEAD on ${target} is no longer an ancestor of source ${source}; abort (git merge --abort) and re-run`,
      },
    };
  }

  // If the predicted tag already points at the target's tip, treat as done
  // (nothing to do this run).
  let plan;
  try {
    plan = planBump(target, repoRoot, { registry, config });
  } catch (e) {
    const err = e as { kind?: string; message?: string };
    if (err.kind) {
      return {
        kind: 'halt',
        halt: {
          kind: err.kind,
          message: err.message ?? 'halt',
        },
      };
    }
    throw e;
  }

  if (plan.kind === 'noop') {
    return { kind: 'done' };
  }

  // Predicted tag pre-merge. If it already exists at the current commit,
  // we're in the partial state (process killed between merge and tag last
  // run): just write the tag. If it exists at a different commit, halt
  // with tag-version-mismatch.
  const predicted = `${target}/${formatVersion(plan.next)}`;
  const existing = tagShaIfAny(predicted, repoRoot);
  if (existing) {
    const headSha = currentHeadSha(repoRoot);
    if (existing === headSha) {
      // Already tagged; done.
      return { kind: 'done' };
    }
    return {
      kind: 'halt',
      halt: {
        kind: 'tag-version-mismatch',
        message: `${predicted} exists at ${existing.slice(0, 12)} but target tip is ${headSha.slice(0, 12)}`,
      },
    };
  }

  // Perform the merge (no-op merges are legal; we re-plan after).
  const mergeRes = mergePreserve(source, { message: `cascade propagate: merge ${source}` }, repoRoot, registry);
  if (mergeRes.code !== 0) {
    // Conflict or other merge failure.
    const conflictedFiles: string[] = [];
    try {
      const out = git(['diff', '--name-only', '--diff-filter=U'], repoRoot);
      if (out) conflictedFiles.push(...out.split('\n').filter(Boolean));
    } catch {
      /* ignore */
    }
    return {
      kind: 'halt',
      halt: {
        kind: 'merge-conflict',
        message: `conflict merging ${source} into ${target}`,
        details:
          conflictedFiles.length > 0 ? { conflicted_files: conflictedFiles } : undefined,
      },
    };
  }

  // Re-plan after the merge: new commit on target means the D-bump rules
  // re-evaluate. (e.g. a no-op merge leaves plan.kind === 'noop' and no tag
  // is written.)
  let plan2;
  try {
    plan2 = planBump(target, repoRoot, { registry, config });
  } catch (e) {
    const err = e as { kind?: string; message?: string };
    if (err.kind) {
      return { kind: 'halt', halt: { kind: err.kind, message: err.message ?? 'halt' } };
    }
    throw e;
  }
  if (plan2.kind === 'noop') {
    return { kind: 'done' };
  }

  // Compute snapshot for editions.
  const snapshot = /^edition\/[^/]+$/.test(target)
    ? computeSnapshot({ branch: target, version: plan2.next, repoRoot })
    : undefined;

  try {
    const res = writeTag({ branch: target, version: plan2.next, snapshot }, repoRoot);
    return { kind: 'wrote', tag: { branch: target, tag: res.tag, sha: res.sha } };
  } catch (e) {
    if (e instanceof TagExistsError) {
      return {
        kind: 'halt',
        halt: {
          kind: 'tag-version-mismatch',
          message: e.message,
        },
      };
    }
    throw e;
  }
}

export function executePropagate(opts: ExecuteOptions): ExecutionResult {
  const registry = opts.registry ?? loadRegistry(opts.repoRoot);
  const config = opts.config ?? loadConfig(opts.repoRoot);
  const plan = planPropagation({ ...opts, registry, config });

  if (plan.preflight_halt) {
    const env = toEnvelope(plan);
    return {
      halted: env.halted,
      tags_written: [],
      progress: env.progress,
      summary: { advanced: 0, halted: 1, noop: 0 },
    };
  }

  // --after: find the hop whose target matches and determine its blocked_by
  // chain. If no such hop exists (or it's already done), raise the usage
  // error; the CLI translates that into exit 2.
  const skipHops = new Set<string>();
  if (opts.after) {
    const match = plan.hops.find((h) => h.target === opts.after);
    if (!match || match.status === 'done') {
      throw new AfterNoMatchError(opts.after);
    }
    skipHops.add(match.hop);
    // Propagate the skip: any hop with blocked_by in skipHops also skipped.
    let changed = true;
    while (changed) {
      changed = false;
      for (const h of plan.hops) {
        if (skipHops.has(h.hop)) continue;
        if (h.blocked_by && skipHops.has(h.blocked_by)) {
          skipHops.add(h.hop);
          changed = true;
        }
      }
    }
  }

  const tags_written: TagWrite[] = [];
  const done: string[] = [];
  const pending: { hop: string; blocked_by: string | null }[] = [];
  let halted: HaltEnvelope['halted'] = null;
  let advanced = 0;
  let noop = 0;
  const haltedHopNames = new Set<string>();

  for (const h of plan.hops) {
    if (skipHops.has(h.hop)) {
      // Treated as pending; the operator deliberately kicked the can.
      pending.push({ hop: h.hop, blocked_by: null });
      continue;
    }

    if (halted) {
      // Fail-fast: everything after the halt is pending, with blocked_by
      // pointing at the halted hop if appropriate.
      const blocked_by = h.blocked_by ?? null;
      pending.push({ hop: h.hop, blocked_by });
      continue;
    }

    // The planner's would-halt predictions are advisory: an earlier hop in
    // this same run may create the missing source tag (e.g. upstream → core
    // runs before core → channel/telegram). Trust executeHop's re-plan at
    // execution time; if the halt is real, it surfaces there.

    // Execute.
    const res = executeHop(h.source, h.target, registry, config, opts.repoRoot);
    if (res.kind === 'done') {
      done.push(h.hop);
      noop += 1;
      continue;
    }
    if (res.kind === 'wrote' && res.tag) {
      done.push(h.hop);
      tags_written.push(res.tag);
      advanced += 1;
      continue;
    }
    // Halt.
    if (res.halt) {
      halted = {
        hop: h.hop,
        kind: res.halt.kind,
        details: res.halt.details ?? { message: res.halt.message },
        remediation: remediationFor(res.halt.kind),
      };
      haltedHopNames.add(h.hop);
    }
  }

  return {
    halted,
    tags_written,
    progress: { done, pending },
    summary: {
      advanced,
      halted: halted ? 1 : 0,
      noop,
    },
  };
}

// Human renderer for a completed (or halted) execution.
export function formatExecutionHuman(r: ExecutionResult): string {
  const lines: string[] = [];
  for (const t of r.tags_written) {
    // "source -> target" isn't known here; render by target+tag for brevity.
    lines.push(`✓ ${t.branch.padEnd(32)} wrote ${t.tag}`);
  }
  if (r.halted) {
    lines.push('');
    lines.push(`HALT ${r.halted.hop ?? '(pre-flight)'}: ${r.halted.kind}`);
    const msg =
      typeof r.halted.details.message === 'string' ? r.halted.details.message : '';
    if (msg) lines.push(`  ${msg}`);
    if (r.halted.remediation) lines.push(`  → ${r.halted.remediation}`);
  }
  const { advanced, halted, noop } = r.summary;
  lines.push('');
  lines.push(`${advanced} hops advanced, ${halted} halted, ${noop} no-op`);
  return lines.join('\n');
}

export function formatPlanHuman(plan: PropagationPlan): string {
  if (plan.preflight_halt) {
    return (
      `pre-flight halt: ${plan.preflight_halt.kind}\n  ${plan.preflight_halt.message}\n  → ${plan.preflight_halt.remediation}`
    );
  }
  if (plan.hops.length === 0) return 'propagate: no hops to plan';
  const lines: string[] = [];
  for (const h of plan.hops) {
    const statusMark =
      h.status === 'done' ? 'DONE    ' : h.status === 'pending' ? 'PENDING ' : 'HALT    ';
    const tag = h.predicted_tag ? ` → ${h.predicted_tag}` : '';
    const halt = h.halt_kind ? ` [${h.halt_kind}]` : '';
    lines.push(`${statusMark} ${h.source} -> ${h.target}${tag}${halt}`);
  }
  const done = plan.hops.filter((h) => h.status === 'done').length;
  const pending = plan.hops.filter((h) => h.status === 'pending').length;
  const halted = plan.hops.filter((h) => h.status === 'would-halt').length;
  lines.push('');
  lines.push(`${plan.hops.length} hops: ${done} done, ${pending} pending, ${halted} would-halt`);
  return lines.join('\n');
}
