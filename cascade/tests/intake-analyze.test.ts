import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { analyzeIntake } from '../scripts/intake-analyze.js';
import { makeRepo, seedCascadeRegistry, Repo } from './fixtures.js';

// Build a scenario: upstream has N commits ahead of main. Some touch files
// main has diverged on; some touch other files; some are merge commits.

let repo: Repo;
beforeEach(() => {
  repo = makeRepo('cascade-intake-');
  seedCascadeRegistry(repo.root);
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

// Seed: shared base commit, then upstream/main and main branch from it.
function seedBase() {
  repo.write('src/a.ts', 'a0\n');
  repo.write('src/b.ts', 'b0\n');
  repo.write('README.md', 'r0\n');
  repo.commit('base');
  repo.run('branch', 'upstream/main');
}

describe('analyzeIntake — empty range', () => {
  it('zero commits when target already includes source', () => {
    seedBase();
    // main is already at upstream/main; no range.
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.rangeCount).toBe(0);
    expect(r.commits).toHaveLength(0);
    expect(r.segments).toHaveLength(0);
    expect(r.aggregateFiles).toHaveLength(0);
  });
});

describe('analyzeIntake — clean range', () => {
  it('commits adding new files are classified clean and coalesced', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/new1.ts', 'x\n');
    repo.commit('add new1');
    repo.write('src/new2.ts', 'y\n');
    repo.commit('add new2');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.rangeCount).toBe(2);
    expect(r.commits.every((c) => c.primaryKind === 'clean')).toBe(true);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].kind).toBe('clean');
    expect(r.segments[0].commits).toHaveLength(2);
    expect(r.intersection).toHaveLength(0);
    expect(r.predictedConflicts).toHaveLength(0);
  });
});

describe('analyzeIntake — divergence classification', () => {
  it('flags commits that touch files main has diverged on', () => {
    seedBase();
    // fls change on main
    repo.write('src/a.ts', 'a-fls\n');
    repo.commit('fls tweak a');
    // upstream changes same file
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'a-upstream\n');
    repo.commit('upstream tweak a');
    // unrelated upstream commit
    repo.write('src/c.ts', 'c\n');
    repo.commit('add c');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.rangeCount).toBe(2);
    const byKind = r.commits.map((c) => c.primaryKind);
    // First commit: touches src/a.ts which is in divergence set → divergence
    // or conflict depending on merge-tree. Both are fine; but src/a.ts is in
    // divergence set so priority gives 'divergence'.
    expect(byKind[0]).toBe('divergence');
    expect(byKind[1]).toBe('clean');
    expect(r.intersection).toContain('src/a.ts');
    expect(r.divergenceFiles).toContain('src/a.ts');
  });
});

describe('analyzeIntake — predicted conflict', () => {
  it('merge-tree flags the conflicting path', () => {
    seedBase();
    // Divergent content on both sides of the same file, with enough
    // difference to defeat the text merge.
    repo.write('src/a.ts', 'fls-version-line-1\nfls-version-line-2\n');
    repo.commit('fls edit a');
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'upstream-version-line-1\nupstream-version-line-2\n');
    repo.commit('upstream edit a');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.predictedConflicts).toContain('src/a.ts');
  });
});

describe('analyzeIntake — structural (merge commit)', () => {
  it('merge commits get structural singleton segments', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.run('checkout', '-q', '-b', 'upstream-feat');
    repo.write('src/feat.ts', 'feat\n');
    repo.commit('feat');
    repo.checkout('upstream/main');
    repo.merge('upstream-feat', 'merge feat');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const structural = r.commits.filter((c) => c.primaryKind === 'structural');
    expect(structural.length).toBeGreaterThan(0);
    const mergeSeg = r.segments.find((s) => s.kind === 'structural');
    expect(mergeSeg).toBeDefined();
    expect(mergeSeg!.commits).toHaveLength(1);
  });
});

describe('analyzeIntake — break point (tag)', () => {
  it('a tag in the range creates a break_point singleton', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/x.ts', 'x\n');
    repo.commit('pre-tag');
    repo.write('src/y.ts', 'y\n');
    const taggedSha = repo.commit('v1.0');
    repo.run('tag', 'v1.0', taggedSha);
    repo.write('src/z.ts', 'z\n');
    repo.commit('post-tag');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const bp = r.commits.find((c) => c.primaryKind === 'break_point');
    expect(bp).toBeDefined();
    expect(bp!.tags).toContain('v1.0');
    expect(r.breakPoints).toHaveLength(1);
    // Segment singleton, and the segment order: clean, break_point, clean.
    const kinds = r.segments.map((s) => s.kind);
    expect(kinds).toEqual(['clean', 'break_point', 'clean']);
  });
});

describe('analyzeIntake — determinism', () => {
  it('repeat runs at the same state produce the same cacheKey and segments', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'a1\n');
    repo.commit('edit a');
    repo.write('src/new.ts', 'n\n');
    repo.commit('add new');
    repo.checkout('main');
    const a = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const b = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(b.cacheKey).toBe(a.cacheKey);
    expect(b.segments.map((s) => s.kind)).toEqual(a.segments.map((s) => s.kind));
    expect(b.aggregateFiles).toEqual(a.aggregateFiles);
    expect(b.divergenceFiles).toEqual(a.divergenceFiles);
  });
});

describe('analyzeIntake — renames tracked', () => {
  it('captures renames in the range', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.run('mv', 'src/a.ts', 'src/a-renamed.ts');
    repo.commit('rename a');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.renames.length).toBeGreaterThan(0);
    expect(r.renames[0].from).toBe('src/a.ts');
    expect(r.renames[0].to).toBe('src/a-renamed.ts');
  });
});

describe('analyzeIntake — error cases', () => {
  it('throws when source does not exist', () => {
    seedBase();
    expect(() =>
      analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/nope' }),
    ).toThrow(/does not exist/);
  });
});
