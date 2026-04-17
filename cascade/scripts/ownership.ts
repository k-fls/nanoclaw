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
//   5. Otherwise → "default".

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
  const out = git(
    ['log', '--all', '--diff-filter=A', '--name-only', '--format=COMMIT %H %P'],
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

  for (const file of trackedFiles) {
    if (perFileRuleMatch(file)) {
      entries.push({ path: file, owner: 'project' });
      continue;
    }
    const commits = intros.get(file) ?? [];

    // Explicit override wins over derivation. Also suppresses the double-
    // introduction warning for this path (the human has explicitly
    // acknowledged the history).
    const overrideOwner = overrides.get(file);
    if (overrideOwner !== undefined) {
      entries.push({ path: file, owner: overrideOwner });
      overridden.push(file);
      continue;
    }

    if (commits.length === 0) {
      entries.push({ path: file, owner: 'default' });
      continue;
    }
    // Double-introduction detection: if two commits introduced the same path
    // on independent ancestries (neither is ancestor of the other), that's
    // an error per §9.
    if (commits.length > 1 && !anyAncestorRelation(commits, repoRoot)) {
      doubleIntroductions.push({ path: file, commits });
    }

    let owner: string | null = null;
    // Stage 1: first-parent match (the commit was authored on this branch).
    for (const b of longLived) {
      const fp = firstParent.get(b)!;
      if (commits.some((c) => fp.has(c))) {
        owner = b;
        break;
      }
    }
    // Stage 2: full-ancestry fallback (commit arrived via merge; e.g. upstream
    // import or ephemeral that's been merged in and deleted).
    if (!owner) {
      for (const b of longLived) {
        const anc = ancestry.get(b)!;
        if (commits.some((c) => anc.has(c))) {
          owner = b;
          break;
        }
      }
    }
    if (!owner) {
      unowned.push(file);
      entries.push({ path: file, owner: 'default' });
    } else {
      entries.push({ path: file, owner });
    }
  }

  // Redundant-override detection: an override is redundant only if both:
  //   1. Derivation would have produced the same owner.
  //   2. The path would NOT trigger a double-introduction warning (otherwise
  //      the override is load-bearing — it's silencing the warning).
  for (const p of overridden) {
    const commits = intros.get(p) ?? [];
    if (commits.length === 0) continue;
    const wouldWarnDoubleIntro =
      commits.length > 1 && !anyAncestorRelation(commits, repoRoot);
    if (wouldWarnDoubleIntro) continue;
    const derived = deriveOwnerViaHistory(commits, longLived, firstParent, ancestry);
    const declared = overrides.get(p);
    if (derived && declared && derived === declared) {
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

// Extracted attribution algorithm, reusable for redundant-override checks.
function deriveOwnerViaHistory(
  commits: string[],
  longLived: string[],
  firstParent: Map<string, Set<string>>,
  ancestry: Map<string, Set<string>>,
): string | null {
  for (const b of longLived) {
    const fp = firstParent.get(b);
    if (fp && commits.some((c) => fp.has(c))) return b;
  }
  for (const b of longLived) {
    const anc = ancestry.get(b);
    if (anc && commits.some((c) => anc.has(c))) return b;
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
