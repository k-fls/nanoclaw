// Branch classification and graph queries.
// Implements the class registry from .cascade/branch-classes.yaml.
// See cascade/docs/branch-model.md and cascade/docs/artifacts.md.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import YAML from 'yaml';

export interface BranchClass {
  name: string;
  pattern: string;
  regex: RegExp;
  read_only?: boolean;
  fallback?: boolean;
  not_versioned?: boolean;
  base?: string;
  base_from_match?: string;
  version_source?: string;
  version_source_from_match?: string;
  version_source_from_ancestry?: string;
  co_merges?: string[];
}

export interface BranchInfo {
  name: string;
  class: BranchClass;
  match: RegExpMatchArray;
}

export function loadRegistry(repoRoot: string): BranchClass[] {
  const file = path.join(repoRoot, '.cascade', 'branch-classes.yaml');
  const raw = readFileSync(file, 'utf8');
  const parsed = YAML.parse(raw) as { classes: Omit<BranchClass, 'regex'>[] };
  if (!parsed?.classes?.length) {
    throw new Error(`${file}: missing or empty "classes" list`);
  }
  return parsed.classes.map((c) => ({ ...c, regex: new RegExp(c.pattern) }));
}

export function classOf(branch: string, registry: BranchClass[]): BranchInfo {
  for (const cls of registry) {
    const m = branch.match(cls.regex);
    if (m) return { name: branch, class: cls, match: m };
  }
  // The registry ships with a fallback `.*` entry, so this is unreachable
  // unless someone removed it. Fail loudly rather than silently defaulting.
  throw new Error(`branch "${branch}" matched no class in registry (missing fallback?)`);
}

export function isEphemeral(info: BranchInfo): boolean {
  return info.class.fallback === true;
}

export function isLongLived(info: BranchInfo): boolean {
  return !info.class.fallback && !info.class.read_only;
}

function expand(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$(\d+)/g, (_, n) => {
    const g = match[Number(n)];
    if (g === undefined) throw new Error(`capture group $${n} missing in ${match[0]}`);
    return g;
  });
}

export function parentOf(branch: string, registry: BranchClass[], repoRoot: string): string {
  const info = classOf(branch, registry);
  if (info.class.read_only) {
    throw new Error(`${branch} is a read-only class (${info.class.name}); it has no parent`);
  }
  if (info.class.fallback) {
    // See cascade/docs/artifacts.md §"Ephemerals need special handling".
    // Conceptually the parent is the branch an ephemeral will merge back into,
    // but no Phase 0 consumer needs this; deferring the contract.
    throw new Error(
      `parentOf is not implemented for ephemeral branches in Phase 0 (got "${branch}")`,
    );
  }
  if (info.class.base_from_match) return expand(info.class.base_from_match, info.match);
  if (info.class.base && !info.class.base.includes('*')) return info.class.base;
  if (info.class.base && info.class.base.includes('*')) {
    const re = new RegExp('^' + info.class.base.replace(/\*/g, '[^/]+') + '$');
    const found = findAncestorBranchMatching(branch, re, registry, repoRoot);
    if (!found) {
      throw new Error(`no ancestor branch matching "${info.class.base}" found for ${branch}`);
    }
    return found;
  }
  throw new Error(`registry class "${info.class.name}" has no base for ${branch}`);
}

export function versionSourceOf(
  branch: string,
  registry: BranchClass[],
  repoRoot: string,
): string {
  const info = classOf(branch, registry);
  if (info.class.read_only) {
    throw new Error(`${branch} is read-only; it has no version source`);
  }
  if (info.class.fallback || info.class.not_versioned) {
    throw new Error(`versionSourceOf is not applicable to non-versioned branch "${branch}"`);
  }
  if (info.class.version_source_from_match) {
    return expand(info.class.version_source_from_match, info.match);
  }
  if (info.class.version_source === 'declared') {
    const declared = readParentBranchFile(branch, repoRoot);
    if (!declared) {
      throw new Error(
        `${branch}: version_source is "declared" but .cascade/parent_branch is missing on this branch`,
      );
    }
    return declared;
  }
  if (info.class.version_source_from_ancestry) {
    const pat = info.class.version_source_from_ancestry;
    const re = new RegExp('^' + pat.replace(/\*/g, '[^/]+') + '$');
    const found = findAncestorBranchMatching(branch, re, registry, repoRoot);
    if (!found) {
      throw new Error(`no ancestor branch matching "${pat}" found for ${branch}`);
    }
    return found;
  }
  if (info.class.version_source) return info.class.version_source;
  throw new Error(`registry class "${info.class.name}" has no version_source for ${branch}`);
}

// Walk the parent chain (via parentOf) up to a read-only/root branch.
// Returns the chain excluding `branch` itself.
export function ancestorsOf(
  branch: string,
  registry: BranchClass[],
  repoRoot: string,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([branch]);
  let current = branch;
  while (true) {
    const info = classOf(current, registry);
    if (info.class.read_only || info.class.fallback) break;
    let parent: string;
    try {
      parent = parentOf(current, registry, repoRoot);
    } catch {
      break;
    }
    if (seen.has(parent)) {
      throw new Error(`cycle in parent chain: ${[...seen, parent].join(' -> ')}`);
    }
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }
  return chain;
}

// ---------- git helpers ----------

export function git(args: string[], repoRoot: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trimEnd();
}

export function gitOk(args: string[], repoRoot: string): boolean {
  try {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// List local branches + remote-tracking branches. Filters origin/HEAD and
// returns names without the `refs/heads/` or `refs/remotes/` prefix.
export function listAllBranches(repoRoot: string): string[] {
  const out = git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    repoRoot,
  );
  return out
    .split('\n')
    .filter((b) => b && !b.endsWith('/HEAD'))
    .map((b) => stripOriginPrefix(b));
}

// Strip a leading remote prefix like `origin/` for local-equivalent comparison.
// `upstream/*` refs are left alone — they intentionally retain the prefix
// because the registry pattern matches against `upstream/main` etc.
function stripOriginPrefix(ref: string): string {
  if (ref.startsWith('upstream/')) return ref;
  const slash = ref.indexOf('/');
  if (slash === -1) return ref;
  const head = ref.slice(0, slash);
  // Only strip known non-upstream remote prefixes by treating everything that
  // isn't `upstream` as potentially a remote. Conservative: leave as-is if
  // it contains a `/` — callers can canonicalize. For Phase 0 we strip `origin/`.
  if (head === 'origin') return ref.slice(slash + 1);
  return ref;
}

// Read .cascade/parent_branch as it exists on the given branch's tip.
export function readParentBranchFile(branch: string, repoRoot: string): string | null {
  try {
    const content = execFileSync(
      'git',
      ['show', `${branch}:.cascade/parent_branch`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = content.trim().split('\n')[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

// Find the nearest ancestor branch (in git merge-history terms) whose name
// matches `re`. Used for deploy → edition resolution.
function findAncestorBranchMatching(
  branch: string,
  re: RegExp,
  registry: BranchClass[],
  repoRoot: string,
): string | null {
  const candidates = listAllBranches(repoRoot).filter((b) => re.test(b) && b !== branch);
  // Keep only branches that are actual ancestors of `branch`.
  const ancestors = candidates.filter((c) => gitOk(['merge-base', '--is-ancestor', c, branch], repoRoot));
  if (ancestors.length === 0) return null;
  // Prefer the tip closest to `branch` by commit distance.
  let best: { name: string; distance: number } | null = null;
  for (const a of ancestors) {
    const count = Number(git(['rev-list', '--count', `${a}..${branch}`], repoRoot));
    if (best === null || count < best.distance) best = { name: a, distance: count };
  }
  return best?.name ?? null;
}
