// History-preserving merge wrapper.
// Implements §5 of cascade/docs/branch-model.md:
//   - Long-lived branches: --no-ff only. Squash and fast-forward forbidden.
//   - Ephemeral branches: any mode.
//
// Note the enforcement boundary — post-hoc FF detection is impossible, so
// true FF prevention lives at the forge. This script is the workstation-side
// guard against accidents.

import { spawnSync } from 'node:child_process';
import { classOf, git, isLongLived, loadRegistry, BranchClass } from './branch-graph.js';

export interface MergeOptions {
  squash?: boolean;
  message?: string;
  noCommit?: boolean;
}

export interface MergeResult {
  target: string;
  source: string;
  code: number;
  stdout: string;
  stderr: string;
}

export function currentBranch(repoRoot: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
}

export function mergePreserve(
  source: string,
  opts: MergeOptions,
  repoRoot: string,
  registry?: BranchClass[],
): MergeResult {
  const reg = registry ?? loadRegistry(repoRoot);
  const target = currentBranch(repoRoot);
  if (target === 'HEAD') {
    throw new Error('merge-preserve: detached HEAD; checkout a branch first');
  }

  const targetInfo = classOf(target, reg);
  const longLived = isLongLived(targetInfo);

  if (longLived && opts.squash) {
    throw new Error(
      `merge-preserve: squash merges are forbidden into long-lived branches (target="${target}", class=${targetInfo.class.name}). See cascade/docs/branch-model.md §5.`,
    );
  }

  const args = ['merge'];
  if (longLived) {
    // --no-ff guarantees a merge commit, which also marks the class transition
    // and keeps future merges from the source viable.
    args.push('--no-ff');
  }
  if (opts.squash) args.push('--squash');
  if (opts.noCommit) args.push('--no-commit');
  if (opts.message) args.push('-m', opts.message);
  args.push(source);

  const res = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    target,
    source,
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}
