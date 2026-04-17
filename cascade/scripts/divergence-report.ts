// Divergence report: render the fls-vs-upstream diff grouped by file and
// function. Implements cascade/docs/processes.md § P4 and the minimal
// surface required by Phase 1.
//
// The report is a projection of `git diff <upstream>..<target>`; no
// sidecar YAML, no registry — the git history IS the record.

import { execFileSync } from 'node:child_process';
import { git, gitOk } from './branch-graph.js';
import { loadConfig } from './version.js';
import { resolveCoreRef } from './intake-analyze.js';

export interface HunkSummary {
  // Function / section header extracted from the hunk's @@ line, if any.
  // Empty string when git did not infer one.
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
}

export interface FileDivergence {
  path: string;
  // Upstream-side path when different (renames, moves). For renames, `path`
  // is the target-side path; `upstreamPath` is the upstream-side path.
  upstreamPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  added: number;
  removed: number;
  hunks: HunkSummary[];
}

export interface DivergenceReport {
  target: string;
  source: string;
  base: string;
  files: FileDivergence[];
  totals: { files: number; added: number; removed: number };
}

export interface ReportOptions {
  repoRoot: string;
  target?: string;
  source?: string;
  // Include files whose only change is pure deletion on one side.
  // Default true.
  includeDeleted?: boolean;
}

export function divergenceReport(opts: ReportOptions): DivergenceReport {
  const { repoRoot } = opts;
  const config = loadConfig(repoRoot);
  const target = opts.target ?? resolveCoreRef(repoRoot);
  const source = opts.source ?? `${config.upstream_remote}/${config.upstream_main_branch}`;

  if (!gitOk(['rev-parse', '--verify', target], repoRoot)) {
    throw new Error(`divergence-report: target "${target}" does not exist`);
  }
  if (!gitOk(['rev-parse', '--verify', source], repoRoot)) {
    throw new Error(`divergence-report: source "${source}" does not exist`);
  }

  const base = git(['merge-base', source, target], repoRoot);
  if (!base) {
    throw new Error(`divergence-report: ${target} and ${source} share no history`);
  }

  // Diff is source..target — "how fls has diverged FROM upstream". Function
  // headers come from -W/--function-context is expensive; we use the default
  // unified diff and parse the @@ inline header.
  const patch = execFileSync(
    'git',
    ['diff', '--no-color', '-M', `${source}..${target}`],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );

  const files = parsePatch(patch);
  const totals = {
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };

  return { target, source, base, files, totals };
}

// ---------------- patch parsing ----------------

function parsePatch(patch: string): FileDivergence[] {
  const lines = patch.split('\n');
  const files: FileDivergence[] = [];
  let cur: FileDivergence | null = null;

  const commit = () => {
    if (cur) files.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      commit();
      // diff --git a/<path-a> b/<path-b> — paths may contain spaces, but git
      // quotes them. Good enough for the common case; fall back to reading
      // the following `--- a/` / `+++ b/` lines.
      cur = {
        path: '',
        status: 'M',
        added: 0,
        removed: 0,
        hunks: [],
      };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) {
      cur.status = 'R';
      cur.upstreamPath = line.slice('rename from '.length).trim();
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length).trim();
    } else if (line.startsWith('copy from ')) {
      cur.status = 'C';
      cur.upstreamPath = line.slice('copy from '.length).trim();
    } else if (line.startsWith('copy to ')) {
      cur.path = line.slice('copy to '.length).trim();
    } else if (line.startsWith('--- ')) {
      const p = stripDiffPathPrefix(line.slice(4).trim());
      if (p && !cur.upstreamPath && p !== '/dev/null') cur.upstreamPath = p;
    } else if (line.startsWith('+++ ')) {
      const p = stripDiffPathPrefix(line.slice(4).trim());
      if (p && !cur.path && p !== '/dev/null') cur.path = p;
    } else if (line.startsWith('@@')) {
      const h = parseHunkHeader(line);
      if (h) {
        // Count added/removed lines in this hunk body.
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git ')) {
          body.push(lines[j]);
          j++;
        }
        for (const b of body) {
          if (b.startsWith('+') && !b.startsWith('+++')) h.addedLines++;
          else if (b.startsWith('-') && !b.startsWith('---')) h.removedLines++;
        }
        cur.hunks.push(h);
        cur.added += h.addedLines;
        cur.removed += h.removedLines;
        i = j - 1;
      }
    }
  }
  commit();

  // Deduplicate path: if a rename set `path` via `rename to` AND `+++`
  // repeated it, we're fine. If only `+++` set it, keep that.
  for (const f of files) {
    if (!f.path && f.upstreamPath) f.path = f.upstreamPath;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function stripDiffPathPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  // Quoted paths ("a/name with spaces") — simple unquote.
  if (p.startsWith('"') && p.endsWith('"')) {
    const inner = p.slice(1, -1);
    if (inner.startsWith('a/') || inner.startsWith('b/')) return inner.slice(2);
    return inner;
  }
  return p;
}

// Parse `@@ -l,s +l,s @@ optional header`.
function parseHunkHeader(line: string): HunkSummary | null {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    header: (m[5] ?? '').trim(),
    addedLines: 0,
    removedLines: 0,
  };
}

// ---------------- pretty-print ----------------

export function formatDivergenceReport(
  r: DivergenceReport,
  opts: { verbose?: boolean } = {},
): string {
  const out: string[] = [];
  out.push(`divergence: ${r.target} vs ${r.source}`);
  out.push(`  base:   ${r.base.slice(0, 12)}`);
  out.push(`  files:  ${r.totals.files}`);
  out.push(`  lines:  +${r.totals.added} / -${r.totals.removed}`);
  out.push('');
  for (const f of r.files) {
    const rename = f.status === 'R' && f.upstreamPath ? ` (rename from ${f.upstreamPath})` : '';
    const copy = f.status === 'C' && f.upstreamPath ? ` (copy from ${f.upstreamPath})` : '';
    out.push(`${f.status} ${f.path}   +${f.added}/-${f.removed}${rename}${copy}`);
    if (opts.verbose) {
      for (const h of f.hunks) {
        const header = h.header ? `  ${h.header}` : '';
        out.push(
          `   @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ +${h.addedLines}/-${h.removedLines}${header}`,
        );
      }
    }
  }
  return out.join('\n');
}
