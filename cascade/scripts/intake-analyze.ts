// Read-only P1 intake analyzer.
// Implements cascade/docs/processes.md § P1 pre-merge analysis.
// Deterministic: same (target, source) input produces the same output at
// the same repo state.
//
// Scope: analyze the range merge-base(target, source)..source (commits in
// source not yet in target). Emit a structured report with per-commit
// signals (kinds, divergence, conflicts, break points, renames, fls-
// deletion groups). No grouping — the triage agent forms groups from these
// signals. The intake-validate script enforces post-triage invariants.

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
  // This (commit, path)'s diff vs parent is non-empty but empty under
  // --ignore-all-space. Not set on R/C (rename) or merge-commit entries.
  whitespaceOnly?: boolean;
  // SHA of a later commit D in the range where blobAt(D, path) equals the
  // path's state at some sequence-position strictly before this commit —
  // i.e. this commit lies inside a rollback window on this path. Not set on
  // R/C (rename) or merge-commit entries.
  revertedAt?: string;
}

export interface CommitInfo {
  sha: string;
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

// An inspection component — a connected component of upstream-range commits
// that share at least one touched file (transitively). See
// cascade/docs/inspection.md § Component grouping for the algorithm and
// rationale. A component is the atomic unit the inspectors operate on:
// commits inside a component are reasoned about together because upstream's
// work on them is file-wise coupled.
export interface InspectionComponent {
  // Stable id = sha256(sorted member shas).slice(0, 16). Determinism guaranteed
  // because the union-find order is deterministic against the analyzer's
  // topo-ordered commit list.
  id: string;
  // Upstream range commits in this component, in analyzer (topo) order.
  commits: string[];
  // Union of every path touched by the component's commits (both focus and
  // context files). Sorted.
  allTouchedFiles: string[];
}

// A component that contains at least one file our target discarded post-base
// that upstream kept modifying in-range. The "discarded" inspector runs on
// the `discardedFiles` subset; the component's full commit set is context.
// Question the inspector answers: "upstream is still actively working on
// files our target chose to remove — is that work worth retaining?"
export interface DiscardedGroup {
  component: InspectionComponent;
  // Files the target removed since base, on which upstream's in-range delta
  // (added + removed) is ≥ config.discarded_min_delta_lines.
  discardedFiles: DiscardedFile[];
}

export interface DiscardedFile {
  path: string;
  // Target commit that removed the path; 'unknown' for rename-then-delete
  // we don't follow (cascade/docs/ownership.md).
  removalSha: string | 'unknown';
  removalSubject: string;
  removalAuthorDate: string;
  // Upstream delta (added + removed) on the path since merge-base, in lines.
  upstreamAdded: number;
  upstreamRemoved: number;
  upstreamTouchingCommits: string[];
}

// A component that contains at least one file upstream introduced in-range
// that our target never had. The "introduced" inspector runs on the
// `introducedFiles` subset; the component's full commit set is context.
// Question the inspector answers: "upstream has built new surface our
// target doesn't have — is that surface worth adopting?"
export interface IntroducedGroup {
  component: InspectionComponent;
  // Files our target does not have that upstream introduced, filtered to
  // file sizes ≥ config.introduced_min_file_lines on source tip.
  introducedFiles: IntroducedFile[];
}

export interface IntroducedFile {
  path: string;
  // Upstream commit that first introduced the path on source's history.
  introductionSha: string;
  introductionSubject: string;
  introductionAuthorDate: string;
  // Size of the file on source tip, in lines. Introduction's natural metric
  // — what our target will acquire — contrasted with the churn metric used
  // for discarded files.
  fileLines: number;
  upstreamTouchingCommits: string[];
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
  // Components containing files the target discarded that upstream kept
  // modifying; the "discarded" inspector runs on each. Filtered by
  // config.yaml `discarded_min_delta_lines`.
  discardedGroups: DiscardedGroup[];
  // Components containing files upstream introduced that the target doesn't
  // have; the "introduced" inspector runs on each. Filtered by config.yaml
  // `introduced_min_file_lines`.
  introducedGroups: IntroducedGroup[];
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

  // Annotate per-(commit, path) signals used by the validator's attention-
  // floor exemption: whitespace-only touches and rollback-window membership.
  // Both mutate entries in CommitInfo.files in place. The whitespace signal
  // is gated on config.intake_whitespace_only (default true; disable for
  // projects where whitespace is semantic — Python, YAML, Make, etc.).
  if (config.intake_whitespace_only) annotateWhitespaceOnly(commits, repoRoot);
  annotateRevertedAt(commits, base, repoRoot);

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

  const breakPoints = commits
    .filter((c) => c.primaryKind === 'break_point')
    .map((c) => ({ sha: c.sha, refs: c.tags }));

  const { discardedGroups, introducedGroups } = computeInspectionGroups({
    repoRoot,
    base,
    target,
    source,
    commits,
    discardedMinDeltaLines: config.discarded_min_delta_lines,
    introducedMinFileLines: config.introduced_min_file_lines,
  });

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
    discardedGroups,
    introducedGroups,
    cacheKey,
  };
}

// ---------------- inspection component grouping ----------------

// Compute the two inspection-group arrays from the upstream-range commits.
// The same set of connected components feeds both; each group refers to a
// component by object reference and carries only its focus-file subset.
// See cascade/docs/inspection.md for the algorithm, rationale, and contract
// with the inspector agents.
function computeInspectionGroups(params: {
  repoRoot: string;
  base: string;
  target: string;
  source: string;
  commits: CommitInfo[];
  discardedMinDeltaLines: number;
  introducedMinFileLines: number;
}): { discardedGroups: DiscardedGroup[]; introducedGroups: IntroducedGroup[] } {
  const { repoRoot, base, target, source, commits, discardedMinDeltaLines, introducedMinFileLines } = params;

  // Files present on source tip but absent on target tip. Some were discarded
  // by the target post-base; some were introduced by upstream post-base and
  // the target never had them. Partition by kind below.
  const presentOnSourceAbsentOnTarget = new Set(
    gitNames(['diff', '--diff-filter=D', '--name-only', `${source}..${target}`], repoRoot),
  );

  // Partition by kind: "discarded by target" → discarded facts; "never had"
  // → introduced facts. Paths with no discoverable anchor on either side are
  // dropped — they have no handle we can reason about.
  interface DiscardedFact {
    path: string;
    sha: string | 'unknown';
    subject: string;
    authorDate: string;
    upstreamAdded: number;
    upstreamRemoved: number;
  }
  interface IntroducedFact {
    path: string;
    introductionSha: string;
    introductionSubject: string;
    introductionAuthorDate: string;
    fileLines: number;
  }
  const discardedFacts = new Map<string, DiscardedFact>();
  const introducedFacts = new Map<string, IntroducedFact>();

  for (const path of presentOnSourceAbsentOnTarget) {
    const removalSha = firstRemovalCommit(base, target, path, repoRoot);
    if (removalSha !== 'unknown') {
      const { added, removed } = upstreamNumstat(base, source, path, repoRoot);
      if (added + removed < discardedMinDeltaLines) continue;
      const h = loadCommitHeader(removalSha, repoRoot);
      discardedFacts.set(path, {
        path,
        sha: removalSha,
        subject: h.subject,
        authorDate: h.authorDate,
        upstreamAdded: added,
        upstreamRemoved: removed,
      });
      continue;
    }
    const introSha = firstIntroductionCommit(source, path, repoRoot);
    if (!introSha) continue; // no anchor — drop
    const fileLines = blobLineCount(source, path, repoRoot);
    if (fileLines < introducedMinFileLines) continue;
    const h = loadCommitHeader(introSha, repoRoot);
    introducedFacts.set(path, {
      path,
      introductionSha: introSha,
      introductionSubject: h.subject,
      introductionAuthorDate: h.authorDate,
      fileLines,
    });
  }

  if (discardedFacts.size === 0 && introducedFacts.size === 0) {
    return { discardedGroups: [], introducedGroups: [] };
  }

  // Build per-commit touched-file sets AND per-file touching-commit sets
  // for union-find. Only commits touching a candidate file participate;
  // other commits don't anchor components even if they share a file with
  // a candidate-touching commit (otherwise a repo-wide refactor would
  // collapse everything into one giant component).
  //
  // Actually we DO want full transitive closure per the design: A touches
  // deleted B + file C; D touches C. A and D end up in the same component
  // even if D doesn't touch B. So the commit participates iff it touches
  // any candidate file — or shares any file (transitively) with a commit
  // that does. Implementation: seed with candidate-touching commits, then
  // grow the component via any shared file.
  const candidateFiles = new Set<string>([...discardedFacts.keys(), ...introducedFacts.keys()]);
  const seedCommits = new Set<string>();
  const filesByCommit = new Map<string, Set<string>>();
  for (const c of commits) {
    const touched = new Set<string>();
    for (const f of c.files) {
      touched.add(f.path);
      if (f.oldPath) touched.add(f.oldPath);
    }
    filesByCommit.set(c.sha, touched);
    for (const p of touched) {
      if (candidateFiles.has(p)) {
        seedCommits.add(c.sha);
        break;
      }
    }
  }
  if (seedCommits.size === 0) {
    return { discardedGroups: [], introducedGroups: [] };
  }

  // Union-find over the bipartite commit-file graph, restricted to
  // commits reachable from a seed via shared files. Iterate a worklist:
  // whenever a new commit joins, union it with its files; whenever a new
  // file joins, union it with every commit that touches it.
  const uf = new UnionFind();
  const commitTouchers = new Map<string, Set<string>>(); // file -> commits touching it
  for (const [sha, touched] of filesByCommit) {
    for (const p of touched) {
      const s = commitTouchers.get(p) ?? new Set<string>();
      s.add(sha);
      commitTouchers.set(p, s);
    }
  }

  const visitedCommits = new Set<string>();
  const worklist: string[] = [...seedCommits];
  while (worklist.length) {
    const sha = worklist.pop()!;
    if (visitedCommits.has(sha)) continue;
    visitedCommits.add(sha);
    const touched = filesByCommit.get(sha) ?? new Set<string>();
    for (const p of touched) {
      uf.union(`c:${sha}`, `f:${p}`);
      for (const other of commitTouchers.get(p) ?? []) {
        if (!visitedCommits.has(other)) worklist.push(other);
      }
    }
  }

  // Gather components.
  const byRoot = new Map<string, { commits: Set<string>; files: Set<string> }>();
  for (const sha of visitedCommits) {
    const root = uf.find(`c:${sha}`);
    const entry = byRoot.get(root) ?? { commits: new Set(), files: new Set() };
    entry.commits.add(sha);
    for (const p of filesByCommit.get(sha) ?? []) entry.files.add(p);
    byRoot.set(root, entry);
  }

  // Build components in analyzer (topo) order by earliest member commit.
  const topoIndex = new Map<string, number>();
  commits.forEach((c, i) => topoIndex.set(c.sha, i));
  const components: InspectionComponent[] = [];
  const compFiles = new Map<string, Set<string>>();
  for (const [, entry] of byRoot) {
    const commitList = [...entry.commits].sort(
      (a, b) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0),
    );
    const id = componentId(commitList);
    components.push({
      id,
      commits: commitList,
      allTouchedFiles: [...entry.files].sort(),
    });
    compFiles.set(id, entry.files);
  }
  components.sort(
    (a, b) => (topoIndex.get(a.commits[0]) ?? 0) - (topoIndex.get(b.commits[0]) ?? 0),
  );

  // Per-component file lookups for deletion/addition groups.
  const discardedGroups: DiscardedGroup[] = [];
  const introducedGroups: IntroducedGroup[] = [];
  const touchingByPath = buildTouchingByPath(commits);

  for (const component of components) {
    const files = compFiles.get(component.id)!;
    const discardedFiles: DiscardedFile[] = [];
    const introducedFiles: IntroducedFile[] = [];
    for (const p of [...files].sort()) {
      const d = discardedFacts.get(p);
      if (d) {
        discardedFiles.push({
          path: d.path,
          removalSha: d.sha,
          removalSubject: d.subject,
          removalAuthorDate: d.authorDate,
          upstreamAdded: d.upstreamAdded,
          upstreamRemoved: d.upstreamRemoved,
          upstreamTouchingCommits: (touchingByPath.get(p) ?? []).sort(),
        });
        continue;
      }
      const i = introducedFacts.get(p);
      if (i) {
        introducedFiles.push({
          path: i.path,
          introductionSha: i.introductionSha,
          introductionSubject: i.introductionSubject,
          introductionAuthorDate: i.introductionAuthorDate,
          fileLines: i.fileLines,
          upstreamTouchingCommits: (touchingByPath.get(p) ?? []).sort(),
        });
      }
    }
    if (discardedFiles.length > 0) discardedGroups.push({ component, discardedFiles });
    if (introducedFiles.length > 0) introducedGroups.push({ component, introducedFiles });
  }

  return { discardedGroups, introducedGroups };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function componentId(sortedCommits: string[]): string {
  const h = createHash('sha256');
  for (const s of sortedCommits) {
    h.update(s);
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function buildTouchingByPath(commits: CommitInfo[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of commits) {
    for (const f of c.files) {
      for (const p of [f.path, f.oldPath].filter(Boolean) as string[]) {
        const list = m.get(p) ?? [];
        list.push(c.sha);
        m.set(p, list);
      }
    }
  }
  return m;
}

function blobLineCount(sha: string, path: string, repoRoot: string): number {
  try {
    const out = execFileSync('git', ['show', `${sha}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 128 * 1024 * 1024,
    });
    // Line count = number of newlines; git appends a trailing newline for
    // text files. Binary files throw or produce garbage — we still count
    // newlines as a best-effort metric.
    let n = 0;
    for (let i = 0; i < out.length; i++) if (out.charCodeAt(i) === 0x0a) n++;
    return n;
  } catch {
    return 0;
  }
}

function upstreamNumstat(
  base: string,
  source: string,
  path: string,
  repoRoot: string,
): { added: number; removed: number } {
  const out = git(
    ['diff', '--numstat', `${base}..${source}`, '--', path],
    repoRoot,
  );
  if (!out) return { added: 0, removed: 0 };
  // `added\tremoved\tpath` — "-" for binary files. Treat binary as 0/0.
  const [a, r] = out.split('\t');
  const added = Number(a);
  const removed = Number(r);
  return {
    added: Number.isFinite(added) ? added : 0,
    removed: Number.isFinite(removed) ? removed : 0,
  };
}

function firstRemovalCommit(
  base: string,
  target: string,
  path: string,
  repoRoot: string,
): string | 'unknown' {
  // Most recent deletion of this exact path on target since base. No rename
  // following — consistent with cascade/docs/ownership.md. A file that was
  // renamed-then-deleted won't resolve; returns 'unknown'.
  const out = git(
    [
      'log',
      '--diff-filter=D',
      '--format=%H',
      `${base}..${target}`,
      '--',
      path,
    ],
    repoRoot,
  );
  const first = out.split('\n').find(Boolean);
  return first || 'unknown';
}

// Earliest upstream commit that ADDED this path. Used to anchor
// upstream-addition files (paths fls never had) to the commit that
// introduced them on source. Returns undefined when no add commit is found
// on the source branch.
function firstIntroductionCommit(
  source: string,
  path: string,
  repoRoot: string,
): string | undefined {
  const out = git(
    [
      'log',
      '--diff-filter=A',
      '--format=%H',
      '--reverse',
      source,
      '--',
      path,
    ],
    repoRoot,
  );
  const first = out.split('\n').find(Boolean);
  return first || undefined;
}

function loadCommitHeader(
  sha: string,
  repoRoot: string,
): { subject: string; authorDate: string } {
  const out = execFileSync(
    'git',
    ['show', '-s', '--format=%s%x00%aI', sha],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const [subject, authorDate] = out.split('\0');
  return { subject: subject ?? '', authorDate: (authorDate ?? '').trim() };
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
    subject: subject ?? '',
    author: author ?? '',
    authorDate: (authorDate ?? '').trim(),
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

// ---------------- per-file signals ----------------

// Mark FileChange.whitespaceOnly on (commit, path) pairs whose diff vs the
// first parent is non-empty but disappears under --ignore-all-space. Skipped
// for merge commits (no single baseline) and for rename/copy entries (the
// signal is about content, not name moves).
function annotateWhitespaceOnly(commits: CommitInfo[], repoRoot: string): void {
  for (const c of commits) {
    if (c.isMerge) continue;
    const parent = c.parents[0];
    if (!parent) continue;
    for (const f of c.files) {
      if (f.status === 'R' || f.status === 'C') continue;
      // No-diff: shouldn't normally happen (the file is listed as changed)
      // but treat as "not whitespace-only" defensively.
      const hasDiff = !gitOk(['diff', '--quiet', parent, c.sha, '--', f.path], repoRoot);
      if (!hasDiff) continue;
      const hasNonWs = !gitOk(
        ['diff', '--quiet', '--ignore-all-space', parent, c.sha, '--', f.path],
        repoRoot,
      );
      if (!hasNonWs) f.whitespaceOnly = true;
    }
  }
}

// Mark FileChange.revertedAt on (commit, path) pairs whose commit sits
// inside a rollback window on that path. See cascade/docs/processes.md §
// attention-floor exemption. For each path P touched in the range, build the
// state sequence state[0..n] (state[0] = blobAt(base, P); state[k] = blobAt
// (k-th toucher, P)). For each toucher at sequence position k, set
// revertedAt = sha of commit at smallest j > k such that state[j] appears
// in state[0..k-1]. Undefined otherwise.
function annotateRevertedAt(
  commits: CommitInfo[],
  base: string,
  repoRoot: string,
): void {
  // Gather touchers per path in range order. Skip merges (no meaningful
  // single baseline) and rename/copy entries.
  interface Toucher {
    commitIndex: number;
    file: FileChange;
  }
  const byPath = new Map<string, Toucher[]>();
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (c.isMerge) continue;
    for (const f of c.files) {
      if (f.status === 'R' || f.status === 'C') continue;
      const list = byPath.get(f.path) ?? [];
      list.push({ commitIndex: i, file: f });
      byPath.set(f.path, list);
    }
  }

  for (const [path, touchers] of byPath) {
    if (touchers.length === 0) continue;
    // state[0] = base blob; state[k] = blob after k-th toucher.
    const states: string[] = [blobOid(base, path, repoRoot)];
    for (const t of touchers) {
      states.push(blobOid(commits[t.commitIndex].sha, path, repoRoot));
    }
    // Pre-compute the set of states appearing at each prefix length k.
    // priorStates[k] = set(state[0..k-1]) for k = 1..n+1. We build iteratively.
    const n = touchers.length;
    let priorSet = new Set<string>([states[0]]);
    // For each toucher at sequence-position k (k = 1..n), find smallest j > k
    // where state[j] ∈ priorStates-at-k (== state[0..k-1]).
    for (let k = 1; k <= n; k++) {
      // priorSet currently = state[0..k-1].
      let foundJ = -1;
      for (let j = k + 1; j <= n; j++) {
        if (priorSet.has(states[j])) {
          foundJ = j;
          break;
        }
      }
      if (foundJ > 0) {
        const reverter = commits[touchers[foundJ - 1].commitIndex].sha;
        touchers[k - 1].file.revertedAt = reverter;
      }
      // Advance priorSet for the next iteration: now include state[k].
      priorSet.add(states[k]);
    }
  }
}

// Blob oid for <sha>:<path>. Returns '' (empty) when the path does not exist
// at that commit — empty serves as a distinct sentinel in state sequences.
function blobOid(sha: string, path: string, repoRoot: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${sha}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
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
  const discardedFilesCount = r.discardedGroups.reduce((n, g) => n + g.discardedFiles.length, 0);
  const introducedFilesCount = r.introducedGroups.reduce((n, g) => n + g.introducedFiles.length, 0);
  lines.push(
    `  discarded inspection: ${discardedFilesCount} file(s) across ${r.discardedGroups.length} component(s)`,
  );
  lines.push(
    `  introduced inspection: ${introducedFilesCount} file(s) across ${r.introducedGroups.length} component(s)`,
  );
  let wsOnly = 0;
  let reverted = 0;
  for (const c of r.commits) {
    for (const f of c.files) {
      if (f.whitespaceOnly) wsOnly++;
      if (f.revertedAt) reverted++;
    }
  }
  lines.push(`  whitespace-only touches: ${wsOnly}`);
  lines.push(`  reverted-within-range:   ${reverted}`);
  lines.push('');
  lines.push(`commits (${r.commits.length}) by primary kind:`);
  const byKind: Record<string, number> = {};
  for (const c of r.commits) byKind[c.primaryKind] = (byKind[c.primaryKind] ?? 0) + 1;
  for (const [k, n] of Object.entries(byKind).sort()) {
    lines.push(`  ${k.padEnd(12)} ${n}`);
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
  if (r.discardedGroups.length > 0) {
    lines.push('');
    lines.push('discarded inspection groups (target removed; upstream still working on these):');
    for (const g of r.discardedGroups) {
      lines.push(`  [component:${g.component.id}] commits=${g.component.commits.length}`);
      for (const f of g.discardedFiles) {
        const tag = f.removalSha === 'unknown' ? 'unknown' : `rm:${f.removalSha.slice(0, 7)}`;
        lines.push(
          `    ${f.path}   +${f.upstreamAdded}/-${f.upstreamRemoved}   [${tag}] ${f.removalSubject || '(no subject)'}`,
        );
      }
    }
  }
  if (r.introducedGroups.length > 0) {
    lines.push('');
    lines.push('introduced inspection groups (upstream added; target does not have these):');
    for (const g of r.introducedGroups) {
      lines.push(`  [component:${g.component.id}] commits=${g.component.commits.length}`);
      for (const f of g.introducedFiles) {
        lines.push(
          `    ${f.path}   ${f.fileLines} lines   [intro:${f.introductionSha.slice(0, 7)}] ${f.introductionSubject || '(no subject)'}`,
        );
      }
    }
  }
  lines.push('');
  lines.push(`cacheKey: ${r.cacheKey}`);
  return lines.join('\n');
}
