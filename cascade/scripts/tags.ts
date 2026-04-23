// Single chokepoint for all cascade-written tags.
// Implements cascade/docs/artifacts.md § Tag body schema.
//
// Contract (summary; see artifacts.md for rationale):
//   - Tag name: `<branch>/<A.B.C.D>`. Any other shape is rejected.
//   - Annotated only. Lightweight tags refused.
//   - Body composition is a single deterministic template.
//   - Refuse-to-overwrite: aborts if `<branch>/<A.B.C.D>` already exists in the
//     local ref store. No --force, no bypass-log path. Defends against
//     concurrent writers, hand `git tag`, and step-1 inspect-logic bugs.
//   - edition/*: snapshot is REQUIRED. Every other branch: snapshot forbidden.
//     Fences are emitted iff snapshot is present; text never ships without
//     matching opening+closing fence.

import { execFileSync } from 'node:child_process';
import { formatVersion, Version } from './version.js';

export const SNAPSHOT_FENCE_OPEN = '---cascade-snapshot---';
export const SNAPSHOT_FENCE_CLOSE = '---cascade-snapshot-end---';

// Snapshot shape is validated by snapshot-schema.ts (Step 2). writeTag only
// needs "it's a JSON-serializable object" — keeping the dependency thin.
// `object` is the right constraint: any JSON-serializable structured value
// (not `null`, not a primitive, not an array at the top level).
export type Snapshot = object;

export interface WriteTagArgs {
  branch: string;
  version: Version;
  notes?: string;
  snapshot?: Snapshot;
}

export interface WriteTagResult {
  tag: string;
  sha: string;
}

export class TagExistsError extends Error {
  kind = 'tag-version-mismatch' as const;
  constructor(
    public tag: string,
    public existingSha: string,
  ) {
    super(`tag ${tag} already exists at ${existingSha}; refusing to overwrite`);
  }
}

export class TagNamingError extends Error {
  kind = 'tag-naming' as const;
  constructor(message: string) {
    super(message);
  }
}

export class SnapshotRequiredError extends Error {
  constructor(public branch: string) {
    super(`writeTag: ${branch} matches edition/* but no snapshot was supplied`);
  }
}

export class SnapshotForbiddenError extends Error {
  constructor(public branch: string) {
    super(`writeTag: ${branch} is not an edition; snapshot must be omitted`);
  }
}

function validateBranchName(branch: string): void {
  // Branch name must itself be a valid ref path (no leading slash, no empty
  // segments, no `..`). `<branch>/<A.B.C.D>` forms the tag, so any `//` inside
  // `branch` would corrupt the tag shape.
  if (!branch || branch.startsWith('/') || branch.endsWith('/')) {
    throw new TagNamingError(`invalid branch name for tag: "${branch}"`);
  }
  if (branch.includes('//') || branch.includes('..')) {
    throw new TagNamingError(`invalid branch name for tag: "${branch}"`);
  }
}

export function isEditionBranch(branch: string): boolean {
  return /^edition\/[^/]+$/.test(branch);
}

// Compose the canonical body. Exposed for tests; production goes via writeTag.
export function composeTagBody(args: {
  branch: string;
  version: Version;
  notes?: string;
  snapshot?: Snapshot;
}): string {
  const header = `${args.branch} ${formatVersion(args.version)}`;
  const notesBlock = args.notes ? args.notes.replace(/\s+$/, '') : '';
  const parts = [header, '', notesBlock];
  if (args.snapshot !== undefined) {
    const json = JSON.stringify(args.snapshot, null, 2);
    parts.push('', SNAPSHOT_FENCE_OPEN, json, SNAPSHOT_FENCE_CLOSE);
  }
  // Trailing newline so annotated-tag body ends cleanly.
  return parts.join('\n') + '\n';
}

// Extract the JSON between snapshot fences, or null if the body has no fence.
// Throws on malformed fence (open without close, close without open, nested).
export function parseTagBody(body: string): {
  header: string;
  notes: string;
  snapshot: Snapshot | null;
} {
  const lines = body.split('\n');
  const openIdx = lines.indexOf(SNAPSHOT_FENCE_OPEN);
  const closeIdx = lines.indexOf(SNAPSHOT_FENCE_CLOSE);
  if (openIdx === -1 && closeIdx === -1) {
    const [header = '', , ...rest] = lines;
    return {
      header,
      notes: rest.join('\n').replace(/\s+$/, ''),
      snapshot: null,
    };
  }
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    throw new Error('malformed snapshot fence in tag body');
  }
  // Nested fence = second open before the close.
  const after = lines.slice(openIdx + 1, closeIdx);
  if (after.includes(SNAPSHOT_FENCE_OPEN)) {
    throw new Error('malformed snapshot fence in tag body (nested open)');
  }
  const header = lines[0] ?? '';
  const notesLines = lines.slice(2, openIdx);
  // Drop trailing blank separating notes from the fence.
  while (notesLines.length > 0 && notesLines[notesLines.length - 1] === '') {
    notesLines.pop();
  }
  const jsonStr = after.join('\n');
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(jsonStr) as Snapshot;
  } catch (e) {
    throw new Error(`malformed snapshot JSON in tag body: ${(e as Error).message}`);
  }
  return {
    header,
    notes: notesLines.join('\n'),
    snapshot,
  };
}

function tagRefSha(tag: string, repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function headSha(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

export function writeTag(args: WriteTagArgs, repoRoot: string): WriteTagResult {
  validateBranchName(args.branch);

  if (isEditionBranch(args.branch) && args.snapshot === undefined) {
    throw new SnapshotRequiredError(args.branch);
  }
  if (!isEditionBranch(args.branch) && args.snapshot !== undefined) {
    throw new SnapshotForbiddenError(args.branch);
  }

  const tag = `${args.branch}/${formatVersion(args.version)}`;
  const existing = tagRefSha(tag, repoRoot);
  if (existing !== null) {
    throw new TagExistsError(tag, existing);
  }

  const body = composeTagBody(args);
  // -a annotated, -m sets the body. Use --file-free -F - would require stdin;
  // execFileSync with input is cleaner but -m preserves body verbatim.
  execFileSync('git', ['tag', '-a', tag, '-F', '-'], {
    cwd: repoRoot,
    input: body,
    encoding: 'utf8',
  });

  const sha = headSha(repoRoot);
  process.stderr.write(`wrote tag ${tag} -> ${sha}\n`);
  return { tag, sha };
}

// Read the annotated-tag body. Returns null if tag doesn't exist.
export function readTagBody(tag: string, repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['tag', '-l', '--format=%(contents)', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
