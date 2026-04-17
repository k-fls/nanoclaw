// Append-only log of acknowledged CI bypasses.
// Schema (whitespace-separated): commit_sha  date(YYYY-MM-DD)  branch  rule  reason
// Implements cascade/docs/artifacts.md § .cascade/bypass-log.
//
// Trust model: any committer can append an entry. This is intentional — the
// threat model is accidental mistakes, not adversarial committers.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, gitOk } from './branch-graph.js';

export interface BypassEntry {
  commit: string;
  date: string; // YYYY-MM-DD
  branch: string;
  rule: string;
  reason: string;
}

const KNOWN_RULES = new Set([
  'determinism',
  'merge-preserve',
  'base-validity',
  'double-introduction',
  'prefix-mismatch',
  'dead-rule',
  'unowned',
]);

export function bypassLogPath(repoRoot: string): string {
  return path.join(repoRoot, '.cascade', 'bypass-log');
}

export function readBypassLog(repoRoot: string): BypassEntry[] {
  const file = bypassLogPath(repoRoot);
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf8');
  const entries: BypassEntry[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      throw new Error(`bypass-log: malformed line (need 5 whitespace-separated fields): "${line}"`);
    }
    const [commit, date, branch, rule, ...rest] = parts;
    entries.push({
      commit,
      date,
      branch,
      rule,
      reason: rest.join(' '),
    });
  }
  return entries;
}

// Policy patterns — standing bypass entries whose "commit" field is a named
// pattern rather than a sha. The matcher resolves the pattern at check time.
const POLICY_PATTERNS = new Set(['upstream/*']);

export function isPolicyPattern(commit: string): boolean {
  return POLICY_PATTERNS.has(commit);
}

export function validateEntry(e: BypassEntry, repoRoot: string): void {
  const isPolicy = isPolicyPattern(e.commit);
  if (!isPolicy && !/^[0-9a-f]{7,40}$/.test(e.commit)) {
    throw new Error(`bypass-log: invalid commit sha "${e.commit}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
    throw new Error(`bypass-log: invalid date "${e.date}" (expected YYYY-MM-DD)`);
  }
  if (!e.branch) throw new Error(`bypass-log: empty branch`);
  if (!KNOWN_RULES.has(e.rule)) {
    throw new Error(
      `bypass-log: unknown rule "${e.rule}"; known rules: ${[...KNOWN_RULES].join(', ')}`,
    );
  }
  if (!e.reason.trim()) throw new Error(`bypass-log: empty reason`);
  if (!isPolicy && !gitOk(['cat-file', '-e', e.commit], repoRoot)) {
    throw new Error(`bypass-log: commit ${e.commit} does not exist in the repo`);
  }
}

export function appendBypass(
  entry: Omit<BypassEntry, 'date'> & { date?: string },
  repoRoot: string,
): BypassEntry {
  const full: BypassEntry = {
    commit: entry.commit,
    date: entry.date ?? new Date().toISOString().slice(0, 10),
    branch: entry.branch,
    rule: entry.rule,
    reason: entry.reason,
  };
  validateEntry(full, repoRoot);
  const file = bypassLogPath(repoRoot);
  const line = `${full.commit}  ${full.date}  ${full.branch}  ${full.rule}  ${full.reason}\n`;
  // Ensure file ends with newline before appending.
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8');
    if (current.length > 0 && !current.endsWith('\n')) {
      appendFileSync(file, '\n');
    }
  } else {
    writeFileSync(file, '', 'utf8');
  }
  appendFileSync(file, line);
  return full;
}
