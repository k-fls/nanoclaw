import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { mergePreserve } from '../scripts/merge-preserve.js';
import { makeRepo, seedCascadeRegistry, Repo } from './fixtures.js';

let repo: Repo;
beforeEach(() => {
  repo = makeRepo('cascade-merge-');
  seedCascadeRegistry(repo.root);
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

describe('mergePreserve', () => {
  it('refuses --squash into a long-lived branch', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('init');
    repo.branch('feature/x');
    repo.checkout('feature/x');
    repo.write('b.ts', 'b\n');
    repo.commit('feat: add b');
    repo.checkout('main');
    expect(() => mergePreserve('feature/x', { squash: true }, repo.root)).toThrow(/squash/i);
  });

  it('allows --squash into an ephemeral target (not long-lived)', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('init');
    repo.branch('feature/target');
    repo.checkout('feature/target');
    repo.write('t.ts', 't\n');
    repo.commit('target: init');
    repo.branch('feature/source');
    repo.checkout('feature/source');
    repo.write('s.ts', 's\n');
    repo.commit('source: add');
    repo.checkout('feature/target');
    // Squash into ephemeral is allowed.
    const res = mergePreserve('feature/source', { squash: true, noCommit: true }, repo.root);
    expect(res.code).toBe(0);
  });

  it('produces a merge commit (--no-ff) for long-lived targets even when FF would be possible', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('init');
    repo.branch('module/foo');
    repo.checkout('module/foo');
    repo.write('b.ts', 'b\n');
    repo.commit('module: add b');
    repo.checkout('main');
    // Linear FF would be possible here; --no-ff must force a merge commit.
    const res = mergePreserve('module/foo', {}, repo.root);
    expect(res.code).toBe(0);
    const parents = repo.run('rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/);
    // <commit> <parent1> <parent2>
    expect(parents.length).toBe(3);
  });

  it('throws when HEAD is detached', () => {
    repo.write('a.ts', 'a\n');
    const sha = repo.commit('init');
    repo.run('checkout', '-q', '--detach', sha);
    expect(() => mergePreserve('main', {}, repo.root)).toThrow(/detached/i);
  });
});
