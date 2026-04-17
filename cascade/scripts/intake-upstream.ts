// Per-group merge executor for P1 upstream intake.
// Implements cascade/docs/processes.md § P1 per-group merge loop.
//
// Input: the terminal SHA of an approved group from the decomposition plan.
// Output: either a completed merge commit on the target branch, or a
// conflicted state surfaced as a structured result (index left in-place so a
// human or the cascade-resolve-conflict agent can draft resolutions).
//
// Strictly non-interactive — no prompting. Orchestration (human approval,
// agent dispatch) lives in the cascade-intake skill/command.

import { spawnSync } from 'node:child_process';
import { git, gitOk, loadRegistry } from './branch-graph.js';
import { mergePreserve, currentBranch } from './merge-preserve.js';

export type IntakeMergeStatus =
  | 'merged'        // merge commit recorded; tree is clean
  | 'noop'          // source already reachable from target; nothing to do
  | 'conflicted';   // merge halted on conflicts; index in unresolved state

export interface ConflictedFile {
  path: string;
  // u/a/d marker letters from `git ls-files -u` → high-level kind. Useful
  // for the resolve-conflict agent to pick prompt variants.
  kind: 'both-modified' | 'added-by-us' | 'added-by-them' | 'deleted-by-us' | 'deleted-by-them' | 'other';
}

export interface IntakeMergeResult {
  status: IntakeMergeStatus;
  target: string;
  source: string;
  upto: string;
  mergeSha?: string;       // present when status === 'merged'
  conflicts: ConflictedFile[];
  stdout: string;
  stderr: string;
}

export interface IntakeMergeOptions {
  repoRoot: string;
  // Terminal commit of the approved group. Merging this SHA brings in
  // everything from the current target tip up through `upto` (git does the
  // reachability math for us).
  upto: string;
  // Human-authored source ref name for the merge message. Not used to
  // resolve content — `upto` is authoritative for the merge target.
  source: string;
  // Merge commit message. Required — the caller (skill/command) should set
  // it to something like `intake upstream: group N (<range>)`.
  message: string;
  // Dry run: validate preconditions and return what would happen, without
  // mutating. Useful in tests and for preview output.
  dryRun?: boolean;
}

export function runIntakeMerge(opts: IntakeMergeOptions): IntakeMergeResult {
  const { repoRoot, upto, source, message } = opts;
  // `rev-parse --verify <sha>` accepts any 40-hex literal even if the object
  // doesn't exist; append `^{commit}` to force object resolution.
  if (!gitOk(['rev-parse', '--verify', `${upto}^{commit}`], repoRoot)) {
    throw new Error(`intake-upstream: commit "${upto}" not found`);
  }
  const target = currentBranch(repoRoot);
  if (target === 'HEAD') {
    throw new Error('intake-upstream: detached HEAD; checkout target branch first');
  }

  // Reject dirty worktree — merges should start from a clean state.
  const status = git(['status', '--porcelain'], repoRoot);
  if (status) {
    throw new Error(
      `intake-upstream: working tree not clean; commit or stash first:\n${status}`,
    );
  }

  // Source already reachable? Nothing to merge.
  if (gitOk(['merge-base', '--is-ancestor', upto, target], repoRoot)) {
    return {
      status: 'noop',
      target,
      source,
      upto,
      conflicts: [],
      stdout: `intake-upstream: ${upto.slice(0, 7)} already in ${target}\n`,
      stderr: '',
    };
  }

  if (opts.dryRun) {
    return {
      status: 'merged',
      target,
      source,
      upto,
      mergeSha: undefined,
      conflicts: [],
      stdout: `intake-upstream: dry-run; would merge ${upto.slice(0, 7)} into ${target}\n`,
      stderr: '',
    };
  }

  // Enforce §5 via mergePreserve. Using --no-commit so we can always attach
  // the crafted intake message, even when git auto-completes a trivial merge.
  const registry = loadRegistry(repoRoot);
  const res = mergePreserve(
    upto,
    { message, noCommit: true },
    repoRoot,
    registry,
  );

  // --no-commit leaves the merge staged (clean) or halts on conflicts.
  const conflicts = readUnmergedFiles(repoRoot);
  if (conflicts.length > 0) {
    return {
      status: 'conflicted',
      target,
      source,
      upto,
      conflicts,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  // Clean staged merge → commit it with the intake message.
  const commit = spawnSync('git', ['commit', '--no-edit', '-m', message], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if ((commit.status ?? 1) !== 0) {
    return {
      status: 'conflicted',
      target,
      source,
      upto,
      conflicts: readUnmergedFiles(repoRoot),
      stdout: res.stdout + (commit.stdout ?? ''),
      stderr: res.stderr + (commit.stderr ?? ''),
    };
  }
  const mergeSha = git(['rev-parse', 'HEAD'], repoRoot);
  return {
    status: 'merged',
    target,
    source,
    upto,
    mergeSha,
    conflicts: [],
    stdout: res.stdout + (commit.stdout ?? ''),
    stderr: res.stderr + (commit.stderr ?? ''),
  };
}

// Abort an in-progress merge, leaving the worktree as it was before the
// attempt. Idempotent: safe to call when no merge is in progress.
export function abortIntakeMerge(repoRoot: string): void {
  if (!isMergeInProgress(repoRoot)) return;
  spawnSync('git', ['merge', '--abort'], { cwd: repoRoot });
}

export function isMergeInProgress(repoRoot: string): boolean {
  const r = spawnSync(
    'git',
    ['rev-parse', '--verify', '-q', 'MERGE_HEAD'],
    { cwd: repoRoot },
  );
  return (r.status ?? 1) === 0;
}

// Continue a previously-conflicted merge after resolutions have been applied
// to the index. The caller is responsible for `git add`-ing the resolved
// files. This function finalizes the commit with the original intake
// message if it's still recoverable, or accepts an override.
export function continueIntakeMerge(
  repoRoot: string,
  message?: string,
): IntakeMergeResult {
  const target = currentBranch(repoRoot);
  if (!isMergeInProgress(repoRoot)) {
    throw new Error('intake-upstream: no merge in progress');
  }
  const conflicts = readUnmergedFiles(repoRoot);
  if (conflicts.length > 0) {
    return {
      status: 'conflicted',
      target,
      source: git(['rev-parse', 'MERGE_HEAD'], repoRoot),
      upto: git(['rev-parse', 'MERGE_HEAD'], repoRoot),
      conflicts,
      stdout: '',
      stderr: `intake-upstream: ${conflicts.length} file(s) still unresolved\n`,
    };
  }
  const args = ['commit', '--no-edit'];
  if (message) args.splice(1, 0, '-m', message);
  const commit = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if ((commit.status ?? 1) !== 0) {
    return {
      status: 'conflicted',
      target,
      source: '',
      upto: '',
      conflicts: readUnmergedFiles(repoRoot),
      stdout: commit.stdout ?? '',
      stderr: commit.stderr ?? '',
    };
  }
  const mergeSha = git(['rev-parse', 'HEAD'], repoRoot);
  return {
    status: 'merged',
    target,
    source: '',
    upto: mergeSha,
    mergeSha,
    conflicts: [],
    stdout: commit.stdout ?? '',
    stderr: commit.stderr ?? '',
  };
}

// ---------------- helpers ----------------

function readUnmergedFiles(repoRoot: string): ConflictedFile[] {
  const out = git(['ls-files', '-u', '-z'], repoRoot);
  if (!out) return [];
  // Stages: 1=base, 2=ours, 3=theirs. Group by path → set of stages → kind.
  const stagesByPath = new Map<string, Set<number>>();
  // Output: "<mode> <sha> <stage>\t<path>\0"
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const [meta, path] = rec.split('\t');
    if (!path) continue;
    const parts = meta.split(' ');
    const stage = Number(parts[2]);
    if (!stagesByPath.has(path)) stagesByPath.set(path, new Set());
    stagesByPath.get(path)!.add(stage);
  }
  const out2: ConflictedFile[] = [];
  for (const [path, stages] of [...stagesByPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out2.push({ path, kind: classifyConflict(stages) });
  }
  return out2;
}

function classifyConflict(stages: Set<number>): ConflictedFile['kind'] {
  const hasBase = stages.has(1);
  const hasOurs = stages.has(2);
  const hasTheirs = stages.has(3);
  if (hasBase && hasOurs && hasTheirs) return 'both-modified';
  if (!hasBase && hasOurs && !hasTheirs) return 'added-by-us';
  if (!hasBase && !hasOurs && hasTheirs) return 'added-by-them';
  if (hasBase && !hasOurs && hasTheirs) return 'deleted-by-us';
  if (hasBase && hasOurs && !hasTheirs) return 'deleted-by-them';
  return 'other';
}
