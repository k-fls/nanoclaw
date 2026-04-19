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
}

const DEFAULTS = {
  discarded_min_delta_lines: 10,
  introduced_min_file_lines: 50,
  intake_whitespace_only: true,
};

export function loadConfig(repoRoot: string): RepoConfig {
  const file = path.join(repoRoot, '.cascade', 'config.yaml');
  const parsed = YAML.parse(readFileSync(file, 'utf8')) as Partial<RepoConfig>;
  if (!parsed?.version_depth || !parsed?.upstream_remote || !parsed?.upstream_main_branch) {
    throw new Error(`${file}: required keys missing`);
  }
  return {
    version_depth: parsed.version_depth,
    upstream_remote: parsed.upstream_remote,
    upstream_main_branch: parsed.upstream_main_branch,
    discarded_min_delta_lines:
      parsed.discarded_min_delta_lines ?? DEFAULTS.discarded_min_delta_lines,
    introduced_min_file_lines:
      parsed.introduced_min_file_lines ?? DEFAULTS.introduced_min_file_lines,
    intake_whitespace_only:
      parsed.intake_whitespace_only ?? DEFAULTS.intake_whitespace_only,
  };
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
