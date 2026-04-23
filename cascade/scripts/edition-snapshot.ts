// Computes the edition snapshot embedded in an `edition/<name>/<A.B.C.D>`
// tag body. Pure in the sense that it reads git refs + YAML but never writes
// to the working tree.
//
// Implements cascade/docs/artifacts.md § Edition snapshot.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  BranchClass,
  classOf,
  git,
  gitOk,
  listAllBranches,
  loadRegistry,
} from './branch-graph.js';
import { deriveOwnership } from './ownership.js';
import {
  EditionSnapshot,
  MAX_SNAPSHOT_SCHEMA,
  SnapshotAdapter,
} from './snapshot-schema.js';
import {
  Version,
  formatVersion,
  parseCascadeTag,
  parseUpstreamTag,
  loadConfig,
  RepoConfig,
} from './version.js';

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

function latestTagMatchingReachable(
  rev: string,
  repoRoot: string,
  parse: (tag: string) => Version | null,
): { tag: string; version: Version } | null {
  if (!gitOk(['rev-parse', '--verify', rev], repoRoot)) return null;
  const out = git(['tag', '--merged', rev], repoRoot);
  if (!out) return null;
  let best: { tag: string; version: Version } | null = null;
  for (const tag of out.split('\n')) {
    const v = parse(tag);
    if (!v) continue;
    if (!best || compare4(v, best.version) > 0) best = { tag, version: v };
  }
  return best;
}

function compare4(a: Version, b: Version): number {
  if (a.a !== b.a) return a.a - b.a;
  if (a.b !== b.b) return a.b - b.b;
  if (a.c !== b.c) return a.c - b.c;
  return a.d - b.d;
}

export interface ComputeSnapshotArgs {
  branch: string; // e.g. 'edition/starter'
  version: Version; // the version being tagged
  repoRoot: string;
  // If supplied, uses this revision as the edition tip instead of the branch
  // ref. Normally unset; set only in tests that don't have the branch checked
  // out.
  rev?: string;
  registry?: BranchClass[];
  config?: RepoConfig;
  // Inject a deterministic timestamp for tests. Default: new Date().
  now?: () => Date;
}

export function computeSnapshot(args: ComputeSnapshotArgs): EditionSnapshot {
  const { branch, version, repoRoot } = args;
  const m = branch.match(/^edition\/([^/]+)$/);
  if (!m) {
    throw new Error(`computeSnapshot: branch "${branch}" is not an edition`);
  }
  const editionName = m[1];
  const registry = args.registry ?? loadRegistry(repoRoot);
  const config = args.config ?? loadConfig(repoRoot);

  const tip = args.rev ?? branch;
  if (!gitOk(['rev-parse', '--verify', tip], repoRoot)) {
    throw new Error(`computeSnapshot: cannot resolve edition tip "${tip}"`);
  }

  // core_version: latest cascade tag on core reachable from edition tip.
  // Edition lives downstream of core, so core tags are ancestors.
  const coreTag = latestTagMatchingReachable(tip, repoRoot, (t) =>
    parseCascadeTag(t, 'core'),
  );
  const core_version = coreTag ? formatVersion(coreTag.version) : null;

  // upstream_version: latest upstream-style tag reachable from tip.
  const upstreamTag = latestTagMatchingReachable(tip, repoRoot, parseUpstreamTag);
  const upstream_version = upstreamTag
    ? `${upstreamTag.version.a}.${upstreamTag.version.b}.${upstreamTag.version.c}`
    : null;

  // Walk branches. Anything whose tip is an ancestor of the edition tip and
  // whose class is channel / skill / skill-adapter counts as "included".
  const channels = new Set<string>();
  const skills = new Set<string>();
  const adapters: SnapshotAdapter[] = [];
  for (const b of listAllBranches(repoRoot)) {
    if (b === branch) continue;
    let info;
    try {
      info = classOf(b, registry);
    } catch {
      continue;
    }
    if (!gitOk(['rev-parse', '--verify', b], repoRoot)) continue;
    if (!isAncestor(b, tip, repoRoot)) continue;

    if (info.class.name === 'channel') {
      const name = b.slice('channel/'.length);
      channels.add(name);
    } else if (info.class.name === 'skill') {
      const name = b.slice('skill/'.length);
      skills.add(name);
    } else if (info.class.name === 'skill-adapter') {
      // skill/<slug>/<channel>.
      const parts = b.split('/');
      if (parts.length === 3) {
        adapters.push({ skill: parts[1], channel: parts[2] });
      }
    }
  }

  // Ownership map: derived from the current working tree (caller checks out
  // the edition tip before invoking tag).
  const own = deriveOwnership({ repoRoot, registry });
  const ownership_map: Record<string, string> = {};
  // Sort keys for determinism of the JSON body.
  for (const e of [...own.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    ownership_map[e.path] = e.owner;
  }

  // Raw branch-classes.yaml at the edition tip. We deliberately read the
  // verbatim bytes so consumers can re-parse with their own YAML library
  // and any comments round-trip.
  let branch_classes: string;
  try {
    branch_classes = execFileSync('git', ['show', `${tip}:.cascade/branch-classes.yaml`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    // Fallback to working-tree copy.
    branch_classes = readFileSync(
      path.join(repoRoot, '.cascade', 'branch-classes.yaml'),
      'utf8',
    );
  }

  const now = (args.now ?? (() => new Date()))();

  const sortedChannels = [...channels].sort();
  const sortedSkills = [...skills].sort();
  adapters.sort((a, b) =>
    a.skill === b.skill
      ? a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
      : a.skill < b.skill ? -1 : 1,
  );

  // Suppress unused-warning; config may gain uses in later phases.
  void config;

  return {
    schema_version: MAX_SNAPSHOT_SCHEMA,
    edition: editionName,
    version: formatVersion(version),
    generated_at: now.toISOString(),
    core_version,
    upstream_version,
    included: {
      channels: sortedChannels,
      skills: sortedSkills,
      adapters,
    },
    ownership_map,
    branch_classes,
  };
}
