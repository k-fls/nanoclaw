// Read-only P1 intake analyzer.
// Implements cascade/docs/processes.md § P1 pre-merge analysis and
// mechanical segmentation. Deterministic: same (target, source) input
// produces the same output at the same repo state.
//
// Scope: analyze the range merge-base(target, source)..source (commits in
// source not yet in target). Emit a structured report plus mechanical
// segments (clean / divergence / conflict / structural / break_point).
// No mutation, no merging — strictly read-only.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { classOf, git, gitOk, listAllBranches, loadRegistry } from './branch-graph.js';
import { loadConfig, RepoConfig } from './version.js';

export type SegmentKind =
  | 'clean'
  | 'divergence'
  | 'conflict'
  | 'structural'
  | 'break_point';

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  oldPath?: string; // R/C source
  score?: number;   // R/C similarity percent
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorDate: string; // ISO 8601
  parents: string[];
  isMerge: boolean;
  files: FileChange[];
  // All kinds that apply to this commit (useful for debugging / reports).
  kinds: SegmentKind[];
  // Strict classification used for segmentation — highest-priority kind wins.
  primaryKind: SegmentKind;
  // Upstream tag(s) pointing at this commit.
  tags: string[];
}

export interface Segment {
  index: number;
  kind: SegmentKind;
  commits: string[];
  files: string[];
  // When kind === 'break_point', the first tag name (if any).
  breakPointRef?: string;
}

export interface IntakeReport {
  target: string;
  source: string;
  base: string;
  rangeCount: number;
  commits: CommitInfo[];
  aggregateFiles: string[];
  divergenceFiles: string[];
  intersection: string[];
  predictedConflicts: string[];
  breakPoints: { sha: string; refs: string[] }[];
  renames: { from: string; to: string; sha: string }[];
  segments: Segment[];
  cacheKey: string;
}

export interface AnalyzeOptions {
  repoRoot: string;
  target?: string;
  source?: string;
  config?: RepoConfig;
}

export function analyzeIntake(opts: AnalyzeOptions): IntakeReport {
  const { repoRoot } = opts;
  const config = opts.config ?? loadConfig(repoRoot);
  const target = opts.target ?? resolveCoreRef(repoRoot);
  const source = opts.source ?? `${config.upstream_remote}/${config.upstream_main_branch}`;

  if (!gitOk(['rev-parse', '--verify', target], repoRoot)) {
    throw new Error(`intake: target ref "${target}" does not exist`);
  }
  if (!gitOk(['rev-parse', '--verify', source], repoRoot)) {
    throw new Error(`intake: source ref "${source}" does not exist`);
  }

  const base = git(['merge-base', target, source], repoRoot);
  if (!base) {
    throw new Error(`intake: ${target} and ${source} share no history`);
  }

  // Divergence set — files target has changed vs. base. Used to flag range
  // commits whose edits land on fls-diverged surface.
  const divergenceFiles = gitNames(
    ['diff', '--name-only', `${base}..${target}`],
    repoRoot,
  );
  const divergenceSet = new Set(divergenceFiles);

  // Range commits, oldest first, topological order (stable against branch
  // re-fetches that don't rewrite history).
  const shas = git(
    ['rev-list', '--reverse', '--topo-order', `${base}..${source}`],
    repoRoot,
  )
    .split('\n')
    .filter(Boolean);

  const commits: CommitInfo[] = shas.map((sha) => loadCommit(sha, repoRoot));

  const aggregateFiles = collectAggregateFiles(commits);
  const intersection = aggregateFiles.filter((f) => divergenceSet.has(f));
  const predictedConflicts = predictConflicts(target, source, repoRoot);
  const conflictSet = new Set(predictedConflicts);

  const renames: { from: string; to: string; sha: string }[] = [];
  for (const c of commits) {
    for (const f of c.files) {
      if (f.status === 'R' && f.oldPath) {
        renames.push({ from: f.oldPath, to: f.path, sha: c.sha });
      }
    }
  }

  // Tag each commit with its applicable kinds, then pick primary.
  for (const c of commits) {
    c.kinds = classifyCommit(c, divergenceSet, conflictSet);
    c.primaryKind = selectPrimaryKind(c.kinds);
  }

  const segments = segment(commits);

  const breakPoints = commits
    .filter((c) => c.primaryKind === 'break_point')
    .map((c) => ({ sha: c.sha, refs: c.tags }));

  const cacheKey = computeCacheKey(target, source, base, shas);

  return {
    target,
    source,
    base,
    rangeCount: commits.length,
    commits,
    aggregateFiles,
    divergenceFiles,
    intersection,
    predictedConflicts,
    breakPoints,
    renames,
    segments,
    cacheKey,
  };
}

// ---------------- per-commit loading ----------------

function loadCommit(sha: string, repoRoot: string): CommitInfo {
  // %H %P %s %an %aI — null-separated to survive subjects with special chars.
  const meta = execFileSync(
    'git',
    [
      'show',
      '-s',
      `--format=%H%x00%P%x00%s%x00%an%x00%aI`,
      sha,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const [fullSha, parentStr, subject, author, authorDate] = meta.split('\0');
  const parents = parentStr.trim() ? parentStr.trim().split(' ') : [];
  const isMerge = parents.length > 1;

  const files = loadFileChanges(fullSha, isMerge, repoRoot);
  const tags = upstreamTagsPointingAt(fullSha, repoRoot);

  return {
    sha: fullSha,
    shortSha: fullSha.slice(0, 7),
    subject: subject ?? '',
    author: author ?? '',
    authorDate: authorDate ?? '',
    parents,
    isMerge,
    files,
    kinds: [],
    primaryKind: 'clean',
    tags,
  };
}

function loadFileChanges(
  sha: string,
  isMerge: boolean,
  repoRoot: string,
): FileChange[] {
  // For merge commits, diff against first parent (what the merge introduced
  // to the mainline). Non-merge: default diff-tree is fine.
  const args = isMerge
    ? ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', '-m', '--first-parent', sha]
    : ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', sha];
  const raw = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return parseNameStatusZ(raw);
}

function parseNameStatusZ(raw: string): FileChange[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const out: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    const first = tokens[i++];
    if (!status || first === undefined) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = tokens[i++];
      if (second === undefined) break;
      const score = Number(status.slice(1)) || undefined;
      out.push({
        status: status[0] as FileChange['status'],
        oldPath: first,
        path: second,
        score,
      });
    } else {
      out.push({ status: status[0] as FileChange['status'], path: first });
    }
  }
  return out;
}

function upstreamTagsPointingAt(sha: string, repoRoot: string): string[] {
  // Any tag reachable only from upstream will point here only in an upstream-
  // only range (our caller has already constrained the range to base..source),
  // so every tag pointing at `sha` is treated as an upstream break point.
  const out = execFileSync(
    'git',
    ['tag', '--points-at', sha],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .sort();
}

// ---------------- aggregate + conflict prediction ----------------

function collectAggregateFiles(commits: CommitInfo[]): string[] {
  const set = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      set.add(f.path);
      if (f.oldPath) set.add(f.oldPath);
    }
  }
  return [...set].sort();
}

function gitNames(args: string[], repoRoot: string): string[] {
  const out = git(args, repoRoot);
  if (!out) return [];
  return out.split('\n').filter(Boolean).sort();
}

// Returns the sorted set of paths git predicts will conflict when merging
// source into target. Uses `git merge-tree --write-tree -z` — git ≥2.38.
function predictConflicts(
  target: string,
  source: string,
  repoRoot: string,
): string[] {
  try {
    const out = execFileSync(
      'git',
      ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', target, source],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    // Output format: <tree-oid>\0<path>\0<path>\0... — tree first, conflicted
    // paths (if any) follow. When there are no conflicts the tree is followed
    // by a trailing NUL only, so `parts` after dropping it is empty.
    const parts = out.split('\0').filter((p) => p.length > 0);
    if (parts.length <= 1) return [];
    return parts.slice(1).sort();
  } catch (e) {
    // Exit 1 from merge-tree — the "conflicts exist" outcome on some git
    // builds. Re-parse stdout the same way.
    const err = e as NodeJS.ErrnoException & { stdout?: Buffer | string };
    const out = err.stdout?.toString() ?? '';
    const parts = out.split('\0').filter((p) => p.length > 0);
    if (parts.length <= 1) return [];
    return parts.slice(1).sort();
  }
}

// ---------------- classification ----------------

function classifyCommit(
  c: CommitInfo,
  divergenceSet: Set<string>,
  conflictSet: Set<string>,
): SegmentKind[] {
  const kinds = new Set<SegmentKind>();

  if (c.tags.length > 0) kinds.add('break_point');
  if (c.isMerge) kinds.add('structural');
  if (isApparentRevert(c.subject)) kinds.add('structural');
  if (isLargeRename(c.files)) kinds.add('structural');

  const touchesDivergence = c.files.some(
    (f) => divergenceSet.has(f.path) || (f.oldPath && divergenceSet.has(f.oldPath)),
  );
  if (touchesDivergence) kinds.add('divergence');

  const touchesConflict = c.files.some((f) => conflictSet.has(f.path));
  if (touchesConflict && !touchesDivergence) kinds.add('conflict');

  if (kinds.size === 0) kinds.add('clean');
  return [...kinds];
}

// Highest-priority kind wins. Mirrors the segmentation priority in
// cascade/docs/processes.md § Mechanical segments.
function selectPrimaryKind(kinds: SegmentKind[]): SegmentKind {
  const priority: SegmentKind[] = [
    'break_point',
    'structural',
    'divergence',
    'conflict',
    'clean',
  ];
  for (const k of priority) if (kinds.includes(k)) return k;
  return 'clean';
}

function isApparentRevert(subject: string): boolean {
  return /^Revert\s+"/.test(subject) || /^Revert commit /.test(subject);
}

// Heuristic: a commit dominated by renames (>5 files, >50% R-status).
function isLargeRename(files: FileChange[]): boolean {
  if (files.length <= 5) return false;
  const renames = files.filter((f) => f.status === 'R').length;
  return renames * 2 > files.length;
}

// ---------------- segmentation ----------------

// Strict: any change of primary kind starts a new segment. A `break_point`
// commit is its own segment (closes current segment and stands alone); a
// `structural` commit is also its own segment singleton.
function segment(commits: CommitInfo[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  const isSingleton = (k: SegmentKind) => k === 'break_point' || k === 'structural';

  for (const c of commits) {
    const k = c.primaryKind;
    if (isSingleton(k) || !cur || cur.kind !== k) {
      if (cur) segs.push(cur);
      cur = {
        index: segs.length,
        kind: k,
        commits: [],
        files: [],
        breakPointRef: k === 'break_point' ? c.tags[0] : undefined,
      };
    }
    cur.commits.push(c.sha);
    for (const f of c.files) {
      if (!cur.files.includes(f.path)) cur.files.push(f.path);
    }
    if (isSingleton(k)) {
      cur.files.sort();
      segs.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.files.sort();
    segs.push(cur);
  }
  // Re-index after singletons may have opened/closed segments.
  segs.forEach((s, i) => (s.index = i));
  return segs;
}

// ---------------- helpers ----------------

function computeCacheKey(target: string, source: string, base: string, shas: string[]): string {
  const h = createHash('sha256');
  h.update(target);
  h.update('\0');
  h.update(source);
  h.update('\0');
  h.update(base);
  h.update('\0');
  for (const s of shas) h.update(s);
  return h.digest('hex').slice(0, 16);
}

// Resolve the "core" ref, transparently accepting `main` per the Phase 0
// transition rule (branch-classes.yaml: pattern `^(core|main)$`).
export function resolveCoreRef(repoRoot: string): string {
  const registry = loadRegistry(repoRoot);
  for (const candidate of ['core', 'main']) {
    if (!gitOk(['rev-parse', '--verify', candidate], repoRoot)) continue;
    try {
      const info = classOf(candidate, registry);
      if (info.class.name === 'core') return candidate;
    } catch {
      /* unclassifiable */
    }
  }
  // Fallback: first local branch whose class is "core" per the registry.
  for (const b of listAllBranches(repoRoot)) {
    try {
      if (classOf(b, registry).class.name === 'core') return b;
    } catch {
      /* ignore */
    }
  }
  throw new Error('intake: cannot resolve "core" ref (no branch named core or main)');
}

// ---------------- pretty-print ----------------

export function formatReport(r: IntakeReport): string {
  const lines: string[] = [];
  lines.push(`intake: ${r.target} ← ${r.source}`);
  lines.push(`  base:             ${r.base.slice(0, 12)}`);
  lines.push(`  commits in range: ${r.rangeCount}`);
  lines.push(`  files touched:    ${r.aggregateFiles.length}`);
  lines.push(`  fls divergence:   ${r.divergenceFiles.length} file(s) diverged vs base`);
  lines.push(`  intersection:     ${r.intersection.length} range file(s) touch divergence set`);
  lines.push(`  predicted conflicts: ${r.predictedConflicts.length}`);
  lines.push(`  break points:     ${r.breakPoints.length}`);
  lines.push(`  renames:          ${r.renames.length}`);
  lines.push('');
  lines.push(`segments (${r.segments.length}):`);
  for (const s of r.segments) {
    const tag = s.kind.padEnd(11);
    const label = s.kind === 'break_point' && s.breakPointRef ? ` [${s.breakPointRef}]` : '';
    lines.push(
      `  #${String(s.index).padStart(2, '0')} ${tag} ${s.commits.length} commit(s), ${s.files.length} file(s)${label}`,
    );
  }
  if (r.intersection.length > 0) {
    lines.push('');
    lines.push('divergence intersection:');
    for (const f of r.intersection) lines.push(`  ${f}`);
  }
  if (r.predictedConflicts.length > 0) {
    lines.push('');
    lines.push('predicted conflicts:');
    for (const f of r.predictedConflicts) lines.push(`  ${f}`);
  }
  lines.push('');
  lines.push(`cacheKey: ${r.cacheKey}`);
  return lines.join('\n');
}
