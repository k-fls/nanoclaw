// Ownership derivation.
// Implements cascade/docs/ownership.md.
//
// For each file in the working tree:
//   1. If matched by .cascade/ownership_rules → "project"
//   2. Find the introducing commit (first commit to add the path).
//   3. Owner = first long-lived branch (in registry order, most-general first)
//      whose --first-parent chain contains the introducing commit. This gives
//      the branch where the commit was authored directly.
//   4. Fallback — if no first-parent chain contains it (e.g. a commit
//      introduced on upstream or on a since-deleted ephemeral) — first
//      long-lived branch whose full ancestry contains it. That branch
//      assimilated the change via merge.
//   5. Upstream-reachability — if the intro commit is reachable from any
//      read-only (upstream) ref, owner = the core class's canonical branch.
//      Covers in-progress intakes on scratch branches: the upstream commit
//      is physically present in the working tree but main/core's ref
//      hasn't FF'd yet. Definitional per §2 (upstream flows to core).
//   6. Otherwise → "default".

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import ignoreModule, { Ignore } from 'ignore';
// NodeNext + CJS default export: the value under `.default` is the callable.
const ignoreFn =
  ((ignoreModule as unknown as { default?: (opts?: object) => Ignore }).default ??
    (ignoreModule as unknown as (opts?: object) => Ignore));
import {
  BranchClass,
  classOf,
  git,
  gitOk,
  isLongLived,
  listAllBranches,
  loadRegistry,
} from './branch-graph.js';

export interface OwnershipEntry {
  path: string;
  owner: string;
}

export interface OwnershipResult {
  entries: OwnershipEntry[];
  deadRules: string[]; // ownership_rules patterns that matched no committed file
  hygieneViolations: { pattern: string; path: string }[]; // safety-net pattern matched a committed file
  doubleIntroductions: { path: string; commits: string[] }[];
  unowned: string[]; // files with an introducing commit that no long-lived branch contains
  overridden: string[]; // paths whose owner came from .cascade/ownership_overrides
  // Overrides that are redundant: derivation would have produced the same
  // owner. Surfaced so the list doesn't rot.
  redundantOverrides: { path: string; owner: string }[];
  // Overrides that name a non-existent / unclassifiable owner branch.
  invalidOverrides: { path: string; owner: string; reason: string }[];
}

// Internal advisory type — rename events from git's heuristic, used only
// to suppress rename-induced double-introduction warnings. Not surfaced
// on OwnershipResult: attribution is deterministic (treats every rename
// as a fresh add per cascade/docs/ownership.md), so consumers should not
// rely on this data.
interface RenamePair {
  from: string;
  to: string;
  commit: string;
}

export type RuleKind = 'project-owned' | 'safety-net';
export interface ParsedRule {
  pattern: string; // the gitignore-syntax pattern (prefix stripped)
  kind: RuleKind;
}

// Parses ownership_rules. The `?` prefix marks a safety-net rule; everything
// else is project-owned. The `!` negation prefix is preserved and passed
// through to the gitignore matcher unchanged.
export function loadOwnershipRules(
  repoRoot: string,
): { raw: string[]; rules: ParsedRule[]; matcher: Ignore } {
  const file = path.join(repoRoot, '.cascade', 'ownership_rules');
  const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const rules: ParsedRule[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('?')) {
      rules.push({ pattern: line.slice(1).trim(), kind: 'safety-net' });
    } else {
      rules.push({ pattern: line, kind: 'project-owned' });
    }
  }
  const raw = rules.map((r) => r.pattern);
  const ig = ignoreFn().add(raw);
  return { raw, rules, matcher: ig };
}

// Explicit path → owner mapping from .cascade/ownership_overrides.
// The escape hatch for files whose history is genuinely ambiguous (e.g.
// pre-cascade squash/cherry-pick duplication). Format: one line per entry,
// `path  owner-branch`, whitespace-separated. Comments begin with `#`.
export function loadOwnershipOverrides(repoRoot: string): Map<string, string> {
  const file = path.join(repoRoot, '.cascade', 'ownership_overrides');
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  const content = readFileSync(file, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`ownership_overrides: malformed line "${line}" (expected: path owner)`);
    }
    const p = parts[0];
    const owner = parts.slice(1).join(' ').trim();
    if (map.has(p)) {
      throw new Error(`ownership_overrides: duplicate entry for "${p}"`);
    }
    map.set(p, owner);
  }
  return map;
}

// Returns the set of files currently tracked in the repo (paths from repo root).
function listTrackedFiles(repoRoot: string): string[] {
  const out = git(['ls-files'], repoRoot);
  return out ? out.split('\n') : [];
}

// For every path ever added anywhere in reachable history, the list of
// commits that genuinely introduced it. A path may have been deleted and
// re-added; we keep all real introducing commits.
//
// `git log --diff-filter=A` on a merge commit reports a file as "added" when
// it didn't exist in the first parent's tree — but it may have existed on
// another parent (common case: `git merge main` into a stale branch re-lists
// every file that landed on main while this branch was idle). Those are not
// real introductions. We post-filter: for each merge-commit "addition",
// verify none of the other parents had the file; if any did, skip.
function collectIntroductions(repoRoot: string): Map<string, string[]> {
  // `--no-renames` is load-bearing: per cascade/docs/ownership.md (§"Renames
  // are introductions at the new path"), a rename = fresh introduction and
  // git's rename heuristics must not be consulted (determinism). Without
  // this flag git's diff machinery classifies renames as `R` and
  // `--diff-filter=A` silently drops the new path.
  const out = git(
    ['log', '--all', '--no-renames', '--diff-filter=A', '--name-only', '--format=COMMIT %H %P'],
    repoRoot,
  );
  const intros = new Map<string, string[]>();
  let currentCommit: string | null = null;
  let currentParents: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('COMMIT ')) {
      const parts = line.slice(7).trim().split(/\s+/);
      currentCommit = parts[0] ?? null;
      currentParents = parts.slice(1);
    } else if (line && currentCommit) {
      // Merge commit? Filter out additions that existed on another parent.
      if (currentParents.length > 1 && existedOnAnyNonFirstParent(line, currentParents, repoRoot)) {
        continue;
      }
      const list = intros.get(line);
      if (list) list.push(currentCommit);
      else intros.set(line, [currentCommit]);
    }
  }
  return intros;
}

// Collect every rename event across reachable history. Advisory: used to
// recognize rename-induced "double introductions" (a path appears to be
// added twice when really one of those events is `git mv` of a file
// already present under a different name). The output never influences
// owner attribution — that path goes through `--no-renames` and treats
// the rename as a fresh add at the new path.
//
// `--diff-filter=R` reports rename pairs as `R<score>\t<from>\t<to>`.
function collectRenames(repoRoot: string): RenamePair[] {
  const out = git(
    ['log', '--all', '-M', '--diff-filter=R', '--raw', '--format=COMMIT %H'],
    repoRoot,
  );
  const pairs: RenamePair[] = [];
  let currentCommit: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('COMMIT ')) {
      currentCommit = line.slice(7).trim();
      continue;
    }
    if (!line || !currentCommit) continue;
    // Format: ":<srcMode> <dstMode> <srcSha> <dstSha> R<score>\t<from>\t<to>"
    // `--raw` emits a leading `:` followed by space-separated fields, then
    // a tab-separated `R<score>\tfrom\tto` tail.
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const head = line.slice(0, tabIdx);
    if (!/\sR\d+$/.test(head)) continue;
    const tail = line.slice(tabIdx + 1).split('\t');
    if (tail.length < 2) continue;
    pairs.push({ from: tail[0], to: tail[1], commit: currentCommit });
  }
  return pairs;
}

// Returns true if `path` exists in the tree of any parent except the first.
// (The first parent is the one `--diff-filter=A` already compared against.)
function existedOnAnyNonFirstParent(
  path: string,
  parents: string[],
  repoRoot: string,
): boolean {
  for (let i = 1; i < parents.length; i++) {
    if (gitOk(['cat-file', '-e', `${parents[i]}:${path}`], repoRoot)) {
      return true;
    }
  }
  return false;
}

// For a given branch, the set of commit SHAs reachable along its --first-parent chain.
function firstParentSet(branch: string, repoRoot: string): Set<string> {
  const out = git(['log', '--first-parent', '--format=%H', branch], repoRoot);
  return new Set(out ? out.split('\n') : []);
}

// Full ancestry (all reachable commits) for a branch.
function ancestrySet(branch: string, repoRoot: string): Set<string> {
  const out = git(['rev-list', branch], repoRoot);
  return new Set(out ? out.split('\n') : []);
}

export interface DeriveOptions {
  repoRoot: string;
  registry?: BranchClass[];
}

export function deriveOwnership(opts: DeriveOptions): OwnershipResult {
  const { repoRoot } = opts;
  const registry = opts.registry ?? loadRegistry(repoRoot);

  const { rules, matcher: projectMatcher } = loadOwnershipRules(repoRoot);
  const overrides = loadOwnershipOverrides(repoRoot);
  const trackedFiles = listTrackedFiles(repoRoot);
  const intros = collectIntroductions(repoRoot);
  const renamePairs = collectRenames(repoRoot);
  // Index: target path → set of commits that renamed something into it.
  // Used to filter rename-induced double-intro warnings.
  const renameTargetCommits = new Map<string, Set<string>>();
  for (const r of renamePairs) {
    let s = renameTargetCommits.get(r.to);
    if (!s) {
      s = new Set();
      renameTargetCommits.set(r.to, s);
    }
    s.add(r.commit);
  }

  // Validate overrides: each owner must be a recognized long-lived branch.
  // An override that names an invalid owner is reported and ignored (so the
  // rest of derivation still proceeds).
  const invalidOverrides: { path: string; owner: string; reason: string }[] = [];
  for (const [p, owner] of [...overrides]) {
    try {
      const info = classOf(owner, registry);
      if (!isLongLived(info)) {
        invalidOverrides.push({
          path: p,
          owner,
          reason: `owner "${owner}" is class ${info.class.name}, not long-lived`,
        });
        overrides.delete(p);
      }
    } catch (e) {
      invalidOverrides.push({ path: p, owner, reason: (e as Error).message });
      overrides.delete(p);
    }
  }

  // Long-lived branches, in registry order (most-general first).
  const longLived = longLivedBranchesInOrder(registry, repoRoot);
  const firstParent = new Map<string, Set<string>>();
  const ancestry = new Map<string, Set<string>>();
  for (const b of longLived) {
    firstParent.set(b, firstParentSet(b, repoRoot));
    ancestry.set(b, ancestrySet(b, repoRoot));
  }

  // Upstream refs (read-only per registry) — used for Stage 3 fallback: an
  // intro commit reachable from any upstream ref is definitionally core's,
  // even if core's ref hasn't FF'd to absorb it yet (mid-intake case).
  const upstreamRefs = readOnlyBranchesInOrder(registry, repoRoot);
  const upstreamAncestry = new Map<string, Set<string>>();
  for (const u of upstreamRefs) upstreamAncestry.set(u, ancestrySet(u, repoRoot));
  const coreFallback = coreCanonicalBranch(registry, longLived);

  // Dead-rule + hygiene tracking.
  //   - deadRules: positive patterns (any section) that matched no file.
  //   - hygieneViolations: safety-net patterns that DID match a committed
  //     file (the path that shouldn't be tracked IS tracked).
  const positiveRules = rules.filter((r) => !r.pattern.startsWith('!'));
  const matchedRules = new Set<string>();
  const hygieneViolations: { pattern: string; path: string }[] = [];

  const perFileRuleMatch = (p: string): boolean => {
    for (const r of positiveRules) {
      const single = ignoreFn().add([r.pattern]);
      if (single.ignores(p)) {
        matchedRules.add(r.pattern);
        if (r.kind === 'safety-net') {
          hygieneViolations.push({ pattern: r.pattern, path: p });
        }
      }
    }
    return projectMatcher.ignores(p);
  };

  const entries: OwnershipEntry[] = [];
  const doubleIntroductions: { path: string; commits: string[] }[] = [];
  const unowned: string[] = [];
  const overridden: string[] = [];
  const redundantOverrides: { path: string; owner: string }[] = [];

  // Per-overridden-path derivation record, kept so the redundant-override
  // check can reuse the main loop's mechanical answer instead of re-running
  // a parallel (and inevitably-drifting) derivation. Only populated for
  // paths that have an override entry, since those are the only ones the
  // redundant-check inspects.
  const derivationForOverridden = new Map<
    string,
    { derived: string | null; doubleIntroFired: boolean }
  >();

  for (const file of trackedFiles) {
    if (perFileRuleMatch(file)) {
      entries.push({ path: file, owner: 'project' });
      continue;
    }
    const overrideOwner = overrides.get(file);
    const commits = intros.get(file) ?? [];

    if (commits.length === 0) {
      if (overrideOwner !== undefined) {
        entries.push({ path: file, owner: overrideOwner });
        overridden.push(file);
        derivationForOverridden.set(file, { derived: null, doubleIntroFired: false });
      } else {
        entries.push({ path: file, owner: 'default' });
      }
      continue;
    }
    // Double-introduction detection: if two commits introduced the same path
    // on independent ancestries (neither is ancestor of the other), that's
    // an error per §9. Three suppressions, applied in order:
    //   1. Rename-induced: one of the introducers is a `git mv` whose
    //      target is this path → the second "introduction" is the rename
    //      surfacing under --no-renames, not a real second authoring.
    //   2. Content-equivalent at intro: all introducers store the same blob
    //      at this path → the same content reappeared via cherry-pick /
    //      rebase / squash-from-upstream, not two independent authorings.
    //   3. Reconciled divergence: introducers had differing blobs at intro
    //      time, but the current tree blob matches one of them → the
    //      divergence has been resolved (the surviving content is one of
    //      the original introductions). The warning is post-hoc and not
    //      actionable; the historical record stays in git log.
    // All three are blob-hash equality checks — deterministic, no
    // heuristics, safe to apply unconditionally.
    const isDoubleIntro =
      commits.length > 1 && !anyAncestorRelation(commits, repoRoot);
    let doubleIntroFired = false;
    if (isDoubleIntro) {
      const renameCommitsForPath = renameTargetCommits.get(file);
      const isRenameInduced =
        renameCommitsForPath !== undefined &&
        commits.some((c) => renameCommitsForPath.has(c));
      if (!isRenameInduced) {
        const blobs = new Set<string>();
        for (const c of commits) {
          try {
            blobs.add(git(['rev-parse', `${c}:${file}`], repoRoot));
          } catch {
            blobs.add(`missing:${c}`);
          }
        }
        const isContentEquivalent = blobs.size === 1;
        let isReconciled = false;
        if (!isContentEquivalent) {
          try {
            const treeBlob = git(['rev-parse', `HEAD:${file}`], repoRoot);
            isReconciled = blobs.has(treeBlob);
          } catch {
            /* file not in HEAD (shouldn't happen for tracked files) */
          }
        }
        doubleIntroFired = !isContentEquivalent && !isReconciled;
      }
    }

    let owner: string | null = null;
    if (isDoubleIntro) {
      // Independent introductions on multiple branches. Don't let Stage 1
      // (first-parent on any branch) override Stage 2 on a more-general
      // branch — a single-parent squash/rebase from upstream that re-adds
      // an already-committed file looks like a first-parent introduction
      // on the downstream branch, but the file's true home is upstream.
      // Collapse stages: registry-earliest branch with any hit (fp or anc)
      // wins.
      for (const b of longLived) {
        const fp = firstParent.get(b)!;
        const anc = ancestry.get(b)!;
        if (commits.some((c) => fp.has(c) || anc.has(c))) {
          owner = b;
          break;
        }
      }
    } else {
      // Stage 1: first-parent match (the commit was authored on this branch).
      for (const b of longLived) {
        const fp = firstParent.get(b)!;
        if (commits.some((c) => fp.has(c))) {
          owner = b;
          break;
        }
      }
      // Stage 2: full-ancestry fallback (commit arrived via merge; e.g.
      // upstream import or ephemeral that's been merged in and deleted).
      if (!owner) {
        for (const b of longLived) {
          const anc = ancestry.get(b)!;
          if (commits.some((c) => anc.has(c))) {
            owner = b;
            break;
          }
        }
      }
    }
    // Stage 3: upstream-reachability. A commit reachable from any upstream ref
    // maps to the core class's canonical branch. This covers files present in
    // the working tree via a mid-intake scratch branch before main has FF'd.
    // Skipped if we can't identify a core branch (shouldn't happen in Phase 0;
    // registry always declares `core`).
    if (!owner && coreFallback) {
      for (const u of upstreamRefs) {
        const anc = upstreamAncestry.get(u)!;
        if (commits.some((c) => anc.has(c))) {
          owner = coreFallback;
          break;
        }
      }
    }

    // Override (if present) wins over derivation in the entries map. The
    // redundant-check below reads `derivationForOverridden` to compare
    // override vs. mechanical owner without re-deriving.
    if (overrideOwner !== undefined) {
      entries.push({ path: file, owner: overrideOwner });
      overridden.push(file);
      derivationForOverridden.set(file, { derived: owner, doubleIntroFired });
      // Override silences the warning for this path (the human has
      // acknowledged the history) — do NOT push to doubleIntroductions.
      continue;
    }

    if (doubleIntroFired) {
      doubleIntroductions.push({ path: file, commits });
    }
    if (!owner) {
      unowned.push(file);
      entries.push({ path: file, owner: 'default' });
    } else {
      entries.push({ path: file, owner });
    }
  }

  // Redundant-override detection: an override is redundant if mechanical
  // derivation produces the same owner and the override isn't load-bearing
  // for warning suppression. Reuses the main loop's per-path derivation
  // (single source of truth — no parallel implementation that can drift).
  for (const p of overridden) {
    const d = derivationForOverridden.get(p);
    if (!d || d.derived === null) continue;
    if (d.doubleIntroFired) continue; // override silences a real warning
    const declared = overrides.get(p);
    if (declared && d.derived === declared) {
      redundantOverrides.push({ path: p, owner: declared });
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const deadRules = positiveRules.map((r) => r.pattern).filter((p) => !matchedRules.has(p));
  return {
    entries,
    deadRules,
    hygieneViolations,
    doubleIntroductions,
    unowned,
    overridden,
    redundantOverrides,
    invalidOverrides,
  };
}

// Read-only (upstream) refs, in the order their classes appear in the
// registry. Used for Stage 3 upstream-reachability fallback.
function readOnlyBranchesInOrder(
  registry: BranchClass[],
  repoRoot: string,
): string[] {
  const all = listAllBranches(repoRoot);
  const classified = all
    .map((name) => {
      try {
        return { name, info: classOf(name, registry) };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; info: ReturnType<typeof classOf> } => x !== null)
    .filter((x) => x.info.class.read_only === true);
  const classIndex = new Map<string, number>();
  registry.forEach((c, i) => classIndex.set(c.name, i));
  classified.sort((a, b) => {
    const ia = classIndex.get(a.info.class.name) ?? 999;
    const ib = classIndex.get(b.info.class.name) ?? 999;
    if (ia !== ib) return ia - ib;
    return a.name < b.name ? -1 : 1;
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { name } of classified) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Resolve the core class's canonical branch — the first long-lived branch
// whose class is `core` (per registry). Returns null if none exists.
function coreCanonicalBranch(registry: BranchClass[], longLived: string[]): string | null {
  for (const b of longLived) {
    try {
      if (classOf(b, registry).class.name === 'core') return b;
    } catch {
      /* unclassifiable */
    }
  }
  return null;
}

function longLivedBranchesInOrder(registry: BranchClass[], repoRoot: string): string[] {
  const all = listAllBranches(repoRoot);
  const classified = all
    .map((name) => {
      try {
        return { name, info: classOf(name, registry) };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; info: ReturnType<typeof classOf> } => x !== null)
    .filter((x) => isLongLived(x.info));
  const classIndex = new Map<string, number>();
  registry.forEach((c, i) => classIndex.set(c.name, i));
  classified.sort((a, b) => {
    const ia = classIndex.get(a.info.class.name) ?? 999;
    const ib = classIndex.get(b.info.class.name) ?? 999;
    if (ia !== ib) return ia - ib;
    return a.name < b.name ? -1 : 1;
  });
  // De-duplicate (a branch like `main` may appear via multiple remotes).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { name } of classified) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function anyAncestorRelation(commits: string[], repoRoot: string): boolean {
  // True if at least one commit is an ancestor of another (so they're on the
  // same timeline — not "independent introductions").
  for (let i = 0; i < commits.length; i++) {
    for (let j = 0; j < commits.length; j++) {
      if (i === j) continue;
      try {
        git(['merge-base', '--is-ancestor', commits[i], commits[j]], repoRoot);
        return true;
      } catch {
        /* not an ancestor */
      }
    }
  }
  return false;
}

export function formatOwnershipMap(result: OwnershipResult): string {
  if (result.entries.length === 0) return '';
  const widest = result.entries.reduce((m, e) => Math.max(m, e.path.length), 0);
  const lines = result.entries.map((e) => `${e.path.padEnd(widest)}  ${e.owner}`);
  return lines.join('\n') + '\n';
}

export function writeOwnershipMap(repoRoot: string, result: OwnershipResult): string {
  const file = path.join(repoRoot, '.ownership_map.txt');
  const content = formatOwnershipMap(result);
  writeFileSync(file, content, 'utf8');
  return file;
}
