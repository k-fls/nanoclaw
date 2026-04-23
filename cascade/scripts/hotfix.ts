// Two-target hotfix flow (Phase 2, Step 5).
// Implements cascade/docs/phase-2-hotfix.md — three invocations that shepherd
// an operator through core → hotfix/<slug> → deploy/<name> and back into core
// via symmetric Cascade-Hotfix-Pair: trailers.
//
// Contract summary:
//   - start(): branch hotfix/<slug> off core (or main).
//   - cherryPick(): cherry-pick the ephemeral tip onto deploy, write the
//     forward trailer, then writeTag the deploy (D++).
//   - continueFlow(): merge ephemeral into core, write the reverse trailer
//     (re-derived from a scan of local deploy/* tips).
//
// Propose-only re: tags on core. The reverse merge deliberately does NOT
// auto-tag core; the next `cascade propagate` owns that surface.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  BranchClass,
  classOf,
  git,
  gitOk,
  listAllBranches,
  loadRegistry,
} from './branch-graph.js';
import { loadConfig, planBump, formatVersion, RepoConfig } from './version.js';
import { writeTag, TagExistsError } from './tags.js';
import { mergePreserve } from './merge-preserve.js';

export const PAIR_TRAILER = 'Cascade-Hotfix-Pair';

export interface HotfixHalt {
  kind: string;
  message: string;
  details?: Record<string, unknown>;
  remediation: string;
}

export interface HotfixResult {
  halted: HotfixHalt | null;
  // Populated on success per step.
  ephemeralBranch?: string;
  ephemeralSha?: string;
  cherryPickSha?: string;
  cherryPickBranch?: string;
  tag?: { branch: string; tag: string; sha: string };
  mergeSha?: string;
}

// ---------- helpers ----------

function resolveCoreRef(registry: BranchClass[], repoRoot: string): string | null {
  const candidates: string[] = [];
  for (const b of listAllBranches(repoRoot)) {
    try {
      if (classOf(b, registry).class.name === 'core') candidates.push(b);
    } catch {
      /* skip */
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.includes('core')) return 'core';
  if (candidates.includes('main')) return 'main';
  return candidates[0];
}

function refExists(ref: string, repoRoot: string): boolean {
  return gitOk(['rev-parse', '--verify', ref], repoRoot);
}

function revParse(ref: string, repoRoot: string): string {
  return git(['rev-parse', ref], repoRoot);
}

function checkout(ref: string, repoRoot: string): void {
  execFileSync('git', ['checkout', ref], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function currentBranch(repoRoot: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
}

// Amend HEAD's commit message to add a trailer via `git interpret-trailers`.
// Works on both regular commits and merge commits (--amend preserves parents).
function amendTrailer(trailerValue: string, repoRoot: string): void {
  const currentMsg = execFileSync('git', ['log', '-1', '--format=%B'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const withTrailer = execFileSync(
    'git',
    ['interpret-trailers', '--trailer', `${PAIR_TRAILER}: ${trailerValue}`],
    { cwd: repoRoot, input: currentMsg, encoding: 'utf8' },
  );
  execFileSync('git', ['commit', '--amend', '-F', '-', '--allow-empty'], {
    cwd: repoRoot,
    input: withTrailer,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Find the one (most recent) hotfix/* branch. Returns null if none exist, or
// throws if multiple ambiguous candidates exist.
function findSingleHotfixBranch(repoRoot: string): string | null {
  const out = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/hotfix/'], repoRoot);
  const list = out ? out.split('\n').filter(Boolean) : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  // Pick the most-recently-committed one.
  let best: { name: string; ts: number } | null = null;
  for (const b of list) {
    const ts = Number(git(['log', '-1', '--format=%ct', b], repoRoot));
    if (!best || ts > best.ts) best = { name: b, ts };
  }
  return best?.name ?? null;
}

function isDeployBranch(name: string): boolean {
  return /^deploy\/[^/]+$/.test(name);
}

function isHotfixBranch(name: string): boolean {
  return /^hotfix\/[^/]+$/.test(name);
}

// ---------- start ----------

export function start(
  deployBranch: string,
  slug: string,
  repoRoot: string,
): HotfixResult {
  if (!isDeployBranch(deployBranch)) {
    return {
      halted: {
        kind: 'bad-state',
        message: `not a deploy branch: "${deployBranch}"`,
        remediation: 'pass deploy/<name>',
      },
    };
  }
  if (!slug || slug.includes('/') || slug.includes(' ')) {
    return {
      halted: {
        kind: 'bad-state',
        message: `invalid slug "${slug}"`,
        remediation: 'slug must be a single path segment',
      },
    };
  }
  const registry = loadRegistry(repoRoot);
  const core = resolveCoreRef(registry, repoRoot);
  if (!core) {
    return {
      halted: {
        kind: 'bad-state',
        message: 'no core branch found in this repo',
        remediation: 'create core or main first',
      },
    };
  }
  if (!refExists(deployBranch, repoRoot)) {
    return {
      halted: {
        kind: 'bad-state',
        message: `deploy branch "${deployBranch}" does not exist`,
        remediation: 'create the deploy branch first',
      },
    };
  }

  const ephemeral = `hotfix/${slug}`;
  if (refExists(ephemeral, repoRoot)) {
    return {
      halted: {
        kind: 'bad-state',
        message: `branch ${ephemeral} already exists`,
        remediation: `delete it (git branch -D ${ephemeral}) or pick a different slug`,
      },
    };
  }

  execFileSync('git', ['checkout', '-b', ephemeral, core], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    halted: null,
    ephemeralBranch: ephemeral,
    ephemeralSha: revParse('HEAD', repoRoot),
  };
}

// ---------- cherry-pick ----------

export function cherryPick(deployBranch: string, repoRoot: string): HotfixResult {
  if (!isDeployBranch(deployBranch)) {
    return {
      halted: {
        kind: 'bad-state',
        message: `not a deploy branch: "${deployBranch}"`,
        remediation: 'pass deploy/<name>',
      },
    };
  }
  if (!refExists(deployBranch, repoRoot)) {
    return {
      halted: {
        kind: 'bad-state',
        message: `deploy branch "${deployBranch}" does not exist`,
        remediation: 'create the deploy branch first',
      },
    };
  }

  // Locate the ephemeral. Prefer the currently-checked-out hotfix/*; fall back
  // to "the single most recent hotfix/* branch".
  const head = currentBranch(repoRoot);
  let ephemeral: string | null = null;
  if (isHotfixBranch(head)) {
    ephemeral = head;
  } else {
    ephemeral = findSingleHotfixBranch(repoRoot);
  }
  if (!ephemeral) {
    return {
      halted: {
        kind: 'bad-state',
        message: 'no hotfix/* branch found; run `cascade hotfix <deploy> <slug>` first',
        remediation: 'start a hotfix session first',
      },
    };
  }
  const ephSha = revParse(ephemeral, repoRoot);

  checkout(deployBranch, repoRoot);

  const cp = spawnSync('git', ['cherry-pick', ephSha], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if ((cp.status ?? 1) !== 0) {
    const conflicted = (() => {
      try {
        const out = git(['diff', '--name-only', '--diff-filter=U'], repoRoot);
        return out ? out.split('\n').filter(Boolean) : [];
      } catch {
        return [];
      }
    })();
    return {
      halted: {
        kind: 'merge-conflict',
        message: `cherry-pick of ${ephSha.slice(0, 12)} onto ${deployBranch} conflicted`,
        details: {
          operation: 'cherry-pick',
          ephemeral,
          conflicted_files: conflicted,
        },
        remediation:
          'resolve conflicts, `git add` files, `git cherry-pick --continue`, then re-run `cascade hotfix --cherry-pick`',
      },
    };
  }

  // Write the forward trailer.
  amendTrailer(ephSha, repoRoot);
  const cherrySha = revParse('HEAD', repoRoot);

  // Auto-tag the deploy (D++).
  const registry = loadRegistry(repoRoot);
  const config = loadConfig(repoRoot);
  let plan;
  try {
    plan = planBump(deployBranch, repoRoot, { registry, config });
  } catch (e) {
    const err = e as { kind?: string; message?: string };
    return {
      halted: {
        kind: err.kind ?? 'unknown',
        message: err.message ?? 'planBump failed',
        remediation:
          err.kind === 'no-prior-tag'
            ? 'cascade tag <deploy> --seed <A.B.C.D>'
            : 'see cascade tag <deploy>',
      },
      ephemeralBranch: ephemeral,
      ephemeralSha: ephSha,
      cherryPickSha: cherrySha,
      cherryPickBranch: deployBranch,
    };
  }

  if (plan.kind === 'noop') {
    return {
      halted: null,
      ephemeralBranch: ephemeral,
      ephemeralSha: ephSha,
      cherryPickSha: cherrySha,
      cherryPickBranch: deployBranch,
    };
  }

  try {
    const res = writeTag({ branch: deployBranch, version: plan.next }, repoRoot);
    return {
      halted: null,
      ephemeralBranch: ephemeral,
      ephemeralSha: ephSha,
      cherryPickSha: cherrySha,
      cherryPickBranch: deployBranch,
      tag: { branch: deployBranch, tag: res.tag, sha: res.sha },
    };
  } catch (e) {
    if (e instanceof TagExistsError) {
      return {
        halted: {
          kind: 'tag-version-mismatch',
          message: e.message,
          remediation: 'delete the stale tag (git tag -d <tag>) and re-run',
        },
        ephemeralBranch: ephemeral,
        ephemeralSha: ephSha,
        cherryPickSha: cherrySha,
        cherryPickBranch: deployBranch,
      };
    }
    throw e;
  }
}

// ---------- continue ----------

// Normalise a handle (SHA-ish or hotfix/<slug>) to its ephemeral tip SHA and
// an optional branch name.
function normaliseHandle(
  handle: string,
  repoRoot: string,
): { sha: string; branch: string | null } | null {
  if (isHotfixBranch(handle)) {
    if (!refExists(handle, repoRoot)) return null;
    return { sha: revParse(handle, repoRoot), branch: handle };
  }
  if (!refExists(handle, repoRoot)) return null;
  const sha = revParse(handle, repoRoot);
  // If the SHA happens to match a hotfix branch tip, record that branch.
  const out = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/hotfix/'], repoRoot);
  for (const b of out ? out.split('\n').filter(Boolean) : []) {
    if (revParse(b, repoRoot) === sha) return { sha, branch: b };
  }
  return { sha, branch: null };
}

// Scan all local deploy/* tips within a bounded window for a commit whose body
// contains `Cascade-Hotfix-Pair: <ephSha>`. Returns the cherry-pick SHA.
function findCherryPickForPair(
  ephSha: string,
  repoRoot: string,
  config: RepoConfig,
): { deploy: string; sha: string } | null {
  const days = config.hotfix_loop_warn_days * 2;
  const out = git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/deploy/'],
    repoRoot,
  );
  const deploys = out ? out.split('\n').filter(Boolean) : [];
  for (const deploy of deploys) {
    try {
      const log = git(
        [
          'log',
          '--first-parent',
          `--since=${days} days ago`,
          `--grep=${PAIR_TRAILER}: ${ephSha}`,
          '--format=%H',
          deploy,
        ],
        repoRoot,
      );
      const lines = log ? log.split('\n').filter(Boolean) : [];
      if (lines.length > 0) return { deploy, sha: lines[0] };
    } catch {
      /* skip */
    }
  }
  return null;
}

export function continueFlow(handle: string, repoRoot: string): HotfixResult {
  const norm = normaliseHandle(handle, repoRoot);
  if (!norm) {
    return {
      halted: {
        kind: 'bad-state',
        message: `handle "${handle}" does not resolve to an ephemeral ref or commit`,
        remediation: 'pass <ephemeral-sha> or hotfix/<slug>',
      },
    };
  }
  const { sha: ephSha, branch: ephBranch } = norm;

  const registry = loadRegistry(repoRoot);
  const config = loadConfig(repoRoot);
  const core = resolveCoreRef(registry, repoRoot);
  if (!core) {
    return {
      halted: {
        kind: 'bad-state',
        message: 'no core branch found in this repo',
        remediation: 'create core or main first',
      },
    };
  }

  const pair = findCherryPickForPair(ephSha, repoRoot, config);
  if (!pair) {
    return {
      halted: {
        kind: 'missing-pair',
        message: `no deploy/* commit carries ${PAIR_TRAILER}: ${ephSha.slice(0, 12)} within the last ${config.hotfix_loop_warn_days * 2} days`,
        remediation: 'run `cascade hotfix --cherry-pick <deploy>` first',
      },
      ephemeralBranch: ephBranch ?? undefined,
      ephemeralSha: ephSha,
    };
  }

  checkout(core, repoRoot);

  const source = ephBranch ?? ephSha;
  const res = mergePreserve(
    source,
    { message: `cascade hotfix: merge ${ephBranch ?? ephSha.slice(0, 12)} into ${core}` },
    repoRoot,
    registry,
  );
  if (res.code !== 0) {
    const conflicted = (() => {
      try {
        const out = git(['diff', '--name-only', '--diff-filter=U'], repoRoot);
        return out ? out.split('\n').filter(Boolean) : [];
      } catch {
        return [];
      }
    })();
    return {
      halted: {
        kind: 'merge-conflict',
        message: `conflict merging ${source} into ${core}`,
        details: {
          operation: 'merge',
          source,
          conflicted_files: conflicted,
        },
        remediation:
          'resolve conflicts, `git add` files, `git commit` to finalize the merge, then re-run `cascade hotfix --continue`',
      },
      ephemeralBranch: ephBranch ?? undefined,
      ephemeralSha: ephSha,
    };
  }

  // Write the reverse trailer on the fresh merge commit.
  amendTrailer(pair.sha, repoRoot);
  const mergeSha = revParse('HEAD', repoRoot);

  return {
    halted: null,
    ephemeralBranch: ephBranch ?? undefined,
    ephemeralSha: ephSha,
    cherryPickSha: pair.sha,
    cherryPickBranch: pair.deploy,
    mergeSha,
  };
}

// ---------- check helper (hotfix-loop-open) ----------

export interface LoopOpenViolation {
  deploy: string;
  cherryPickSha: string;
  ephSha: string;
  ageDays: number;
}

// For every deploy/* tip: find cherry-pick commits carrying a pair trailer.
// For each, verify that a commit reachable from the deploy tip (first-parent)
// carries the reverse pair trailer (Cascade-Hotfix-Pair: <cherry-pick-sha>).
// If missing and age > warn_days, produce a violation.
export function findOpenHotfixLoops(
  repoRoot: string,
  config?: RepoConfig,
): LoopOpenViolation[] {
  const cfg = config ?? loadConfig(repoRoot);
  const warnDays = cfg.hotfix_loop_warn_days;
  const windowDays = warnDays * 2;

  const out = git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/deploy/'],
    repoRoot,
  );
  const deploys = out ? out.split('\n').filter(Boolean) : [];
  const nowSec = Math.floor(Date.now() / 1000);
  const violations: LoopOpenViolation[] = [];

  for (const deploy of deploys) {
    let log: string;
    try {
      log = git(
        [
          'log',
          '--first-parent',
          `--since=${windowDays} days ago`,
          `--grep=${PAIR_TRAILER}:`,
          '--format=%H%x1f%ct%x1f%B%x1e',
          deploy,
        ],
        repoRoot,
      );
    } catch {
      continue;
    }
    if (!log) continue;
    const records = log.split('\x1e').map((s) => s.trim()).filter(Boolean);
    for (const rec of records) {
      const [sha, ctStr, body] = rec.split('\x1f');
      if (!sha || !ctStr || !body) continue;
      // Skip the reverse-direction commits (those created by --continue that
      // might also get propagated down and appear on deploy). We want the
      // *cherry-pick* direction: its trailer points at an ephemeral SHA.
      // Heuristic: extract the trailer value and check if it matches another
      // commit on this deploy (that would mean this is the reverse side).
      // Simpler: skip any commit whose pair trailer refers to a commit
      // reachable from the deploy tip (a self-referential match = reverse).
      const matches = Array.from(body.matchAll(new RegExp(`^${PAIR_TRAILER}:\\s*([0-9a-f]{7,40})\\s*$`, 'gm')));
      if (matches.length === 0) continue;
      const pairedSha = matches[0][1];
      const pairedReachable = gitOk(
        ['merge-base', '--is-ancestor', pairedSha, deploy],
        repoRoot,
      );
      if (pairedReachable) {
        // This commit's pair target is on deploy history → this is the
        // reverse (core-origin) merge propagated here, not a cherry-pick.
        continue;
      }
      // Cherry-pick direction. Check for closure: a commit on deploy's
      // first-parent history carrying PAIR_TRAILER: <sha>.
      let closureLog: string;
      try {
        closureLog = git(
          [
            'log',
            '--first-parent',
            `--grep=${PAIR_TRAILER}: ${sha}`,
            '--format=%H',
            deploy,
          ],
          repoRoot,
        );
      } catch {
        closureLog = '';
      }
      if (closureLog) continue;
      const ageDays = (nowSec - Number(ctStr)) / 86400;
      if (ageDays < warnDays) continue;
      violations.push({
        deploy,
        cherryPickSha: sha,
        ephSha: pairedSha,
        ageDays,
      });
    }
  }
  return violations;
}
