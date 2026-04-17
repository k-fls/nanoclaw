import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  appendBypass,
  readBypassLog,
  validateEntry,
  bypassLogPath,
} from '../scripts/bypass.js';

function makeTmpRepo(): { root: string; commit: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bypass-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  writeFileSync(path.join(root, 'file.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  mkdirSync(path.join(root, '.cascade'), { recursive: true });
  writeFileSync(path.join(root, '.cascade', 'bypass-log'), '');
  return { root, commit };
}

let repo: { root: string; commit: string };
beforeEach(() => {
  repo = makeTmpRepo();
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

describe('validateEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(() =>
      validateEntry(
        {
          commit: repo.commit,
          date: '2026-04-17',
          branch: 'main',
          rule: 'merge-preserve',
          reason: 'tested',
        },
        repo.root,
      ),
    ).not.toThrow();
  });

  it('rejects unknown rule', () => {
    expect(() =>
      validateEntry(
        {
          commit: repo.commit,
          date: '2026-04-17',
          branch: 'main',
          rule: 'made-up-rule',
          reason: 'x',
        },
        repo.root,
      ),
    ).toThrow(/unknown rule/);
  });

  it('rejects bad date', () => {
    expect(() =>
      validateEntry(
        { commit: repo.commit, date: '17/04/2026', branch: 'main', rule: 'determinism', reason: 'x' },
        repo.root,
      ),
    ).toThrow(/invalid date/);
  });

  it('accepts the upstream/* policy pattern as a non-sha commit', () => {
    expect(() =>
      validateEntry(
        {
          commit: 'upstream/*',
          date: '2026-04-17',
          branch: 'main',
          rule: 'merge-preserve',
          reason: 'upstream policy',
        },
        repo.root,
      ),
    ).not.toThrow();
  });

  it('rejects malformed sha', () => {
    expect(() =>
      validateEntry(
        { commit: 'zzz', date: '2026-04-17', branch: 'main', rule: 'determinism', reason: 'x' },
        repo.root,
      ),
    ).toThrow(/invalid commit/);
  });

  it('rejects commit not in repo', () => {
    expect(() =>
      validateEntry(
        {
          commit: '0'.repeat(40),
          date: '2026-04-17',
          branch: 'main',
          rule: 'determinism',
          reason: 'x',
        },
        repo.root,
      ),
    ).toThrow(/does not exist/);
  });

  it('rejects empty reason', () => {
    expect(() =>
      validateEntry(
        { commit: repo.commit, date: '2026-04-17', branch: 'main', rule: 'determinism', reason: '   ' },
        repo.root,
      ),
    ).toThrow(/empty reason/);
  });
});

describe('appendBypass / readBypassLog', () => {
  it('appends and round-trips', () => {
    appendBypass(
      { commit: repo.commit, branch: 'main', rule: 'determinism', reason: 'flaky test branch' },
      repo.root,
    );
    const entries = readBypassLog(repo.root);
    expect(entries).toHaveLength(1);
    expect(entries[0].rule).toBe('determinism');
    expect(entries[0].reason).toBe('flaky test branch');
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('appends multiple entries without corrupting format', () => {
    appendBypass({ commit: repo.commit, branch: 'main', rule: 'determinism', reason: 'one' }, repo.root);
    appendBypass({ commit: repo.commit, branch: 'main', rule: 'base-validity', reason: 'two' }, repo.root);
    const entries = readBypassLog(repo.root);
    expect(entries.map((e) => e.rule)).toEqual(['determinism', 'base-validity']);
    expect(entries.map((e) => e.reason)).toEqual(['one', 'two']);
  });

  it('skips comment and blank lines', () => {
    writeFileSync(
      bypassLogPath(repo.root),
      `# header comment\n\n${repo.commit}  2026-04-17  main  determinism  ok\n`,
    );
    const entries = readBypassLog(repo.root);
    expect(entries).toHaveLength(1);
  });

  it('rejects malformed line on read', () => {
    writeFileSync(bypassLogPath(repo.root), 'too few fields here\n');
    expect(() => readBypassLog(repo.root)).toThrow(/malformed/);
  });
});
