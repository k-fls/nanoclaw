import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  abortIntakeMerge,
  continueIntakeMerge,
  isMergeInProgress,
  runIntakeMerge,
} from '../scripts/intake-upstream.js';
import { makeRepo, seedCascadeRegistry, Repo } from './fixtures.js';

let repo: Repo;
beforeEach(() => {
  repo = makeRepo('cascade-intake-merge-');
  seedCascadeRegistry(repo.root);
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

function seedBase() {
  repo.write('src/a.ts', 'a0\n');
  repo.commit('base');
  repo.run('branch', 'upstream/main');
}

describe('runIntakeMerge — clean merge', () => {
  it('creates a merge commit with the given message', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/new.ts', 'new\n');
    const upto = repo.commit('add new');
    repo.checkout('main');
    const r = runIntakeMerge({
      repoRoot: repo.root,
      upto,
      source: 'upstream/main',
      message: 'intake upstream: group 1',
    });
    expect(r.status).toBe('merged');
    expect(r.mergeSha).toBeDefined();
    expect(r.conflicts).toHaveLength(0);
    // Target has a new merge commit.
    const log = repo.run('log', '--oneline', '-n', '1');
    expect(log).toContain('intake upstream: group 1');
  });
});

describe('runIntakeMerge — noop', () => {
  it('returns noop when source already reachable', () => {
    seedBase();
    const r = runIntakeMerge({
      repoRoot: repo.root,
      upto: repo.run('rev-parse', 'upstream/main'),
      source: 'upstream/main',
      message: 'intake upstream: noop test',
    });
    expect(r.status).toBe('noop');
  });
});

describe('runIntakeMerge — conflict surfaced', () => {
  it('detects conflicts and leaves index for resolution', () => {
    seedBase();
    repo.write('src/a.ts', 'a-fls-line-1\na-fls-line-2\n');
    repo.commit('fls edit');
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'a-upstream-line-1\na-upstream-line-2\n');
    const upto = repo.commit('upstream edit');
    repo.checkout('main');
    const r = runIntakeMerge({
      repoRoot: repo.root,
      upto,
      source: 'upstream/main',
      message: 'intake upstream: group X',
    });
    expect(r.status).toBe('conflicted');
    expect(r.conflicts.map((c) => c.path)).toContain('src/a.ts');
    expect(r.conflicts[0].kind).toBe('both-modified');
    expect(isMergeInProgress(repo.root)).toBe(true);
  });
});

describe('continueIntakeMerge — after manual resolution', () => {
  it('finalizes the merge once resolutions are staged', () => {
    seedBase();
    repo.write('src/a.ts', 'fls-version\n');
    repo.commit('fls edit');
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'upstream-version\n');
    const upto = repo.commit('upstream edit');
    repo.checkout('main');
    const start = runIntakeMerge({
      repoRoot: repo.root,
      upto,
      source: 'upstream/main',
      message: 'intake: resolve test',
    });
    expect(start.status).toBe('conflicted');

    // Resolve by picking a merged form.
    writeFileSync(
      path.join(repo.root, 'src/a.ts'),
      'resolved-both\n',
    );
    repo.run('add', 'src/a.ts');

    const done = continueIntakeMerge(repo.root, 'intake: resolve test');
    expect(done.status).toBe('merged');
    expect(done.mergeSha).toBeDefined();
    const head = readFileSync(path.join(repo.root, 'src/a.ts'), 'utf8');
    expect(head).toBe('resolved-both\n');
  });

  it('reports still-unresolved files', () => {
    seedBase();
    repo.write('src/a.ts', 'fls-version\n');
    repo.commit('fls edit');
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'upstream-version\n');
    const upto = repo.commit('upstream edit');
    repo.checkout('main');
    runIntakeMerge({
      repoRoot: repo.root,
      upto,
      source: 'upstream/main',
      message: 'intake: still conflicted',
    });
    const r = continueIntakeMerge(repo.root);
    expect(r.status).toBe('conflicted');
    expect(r.conflicts.map((c) => c.path)).toContain('src/a.ts');
  });
});

describe('abortIntakeMerge', () => {
  it('clears an in-progress merge', () => {
    seedBase();
    repo.write('src/a.ts', 'fls\n');
    repo.commit('fls');
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'up\n');
    const upto = repo.commit('up');
    repo.checkout('main');
    runIntakeMerge({
      repoRoot: repo.root,
      upto,
      source: 'upstream/main',
      message: 'will abort',
    });
    expect(isMergeInProgress(repo.root)).toBe(true);
    abortIntakeMerge(repo.root);
    expect(isMergeInProgress(repo.root)).toBe(false);
  });

  it('is idempotent when no merge in progress', () => {
    seedBase();
    expect(() => abortIntakeMerge(repo.root)).not.toThrow();
  });
});

describe('runIntakeMerge — precondition checks', () => {
  it('refuses when working tree is dirty', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/new.ts', 'new\n');
    const upto = repo.commit('add new');
    repo.checkout('main');
    writeFileSync(path.join(repo.root, 'src/a.ts'), 'dirty\n');
    expect(() =>
      runIntakeMerge({
        repoRoot: repo.root,
        upto,
        source: 'upstream/main',
        message: 'dirty',
      }),
    ).toThrow(/working tree not clean/);
  });

  it('refuses when upto commit does not exist', () => {
    seedBase();
    expect(() =>
      runIntakeMerge({
        repoRoot: repo.root,
        upto: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        source: 'upstream/main',
        message: 'nope',
      }),
    ).toThrow(/not found/);
  });
});

describe('runIntakeMerge — dry run', () => {
  it('previews without mutating', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/new.ts', 'new\n');
    const upto = repo.commit('add new');
    repo.checkout('main');
    const before = repo.run('rev-parse', 'HEAD');
    const r = runIntakeMerge({
      repoRoot: repo.root,
      upto,
      source: 'upstream/main',
      message: 'dry',
      dryRun: true,
    });
    expect(r.status).toBe('merged');
    expect(r.mergeSha).toBeUndefined();
    expect(repo.run('rev-parse', 'HEAD')).toBe(before);
  });
});
