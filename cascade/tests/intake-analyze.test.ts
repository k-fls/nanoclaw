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
  });
});

describe('analyzeIntake — break point (tag)', () => {
  it('a tag in the range marks a commit break_point', () => {
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
    // Surrounding commits stay clean; only the tagged one flips to break_point.
    const kinds = r.commits.map((c) => c.primaryKind);
    expect(kinds).toEqual(['clean', 'break_point', 'clean']);
  });
});

describe('analyzeIntake — determinism', () => {
  it('repeat runs at the same state produce the same cacheKey and commit order', () => {
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
    expect(b.commits.map((c) => c.sha)).toEqual(a.commits.map((c) => c.sha));
    expect(b.commits.map((c) => c.primaryKind)).toEqual(a.commits.map((c) => c.primaryKind));
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

describe('analyzeIntake — fls deletion inspection', () => {
  it('detects a file fls deleted that upstream kept modifying', () => {
    seedBase();
    // fls deletes src/a.ts
    repo.run('rm', 'src/a.ts');
    repo.commit('fls: remove legacy a');
    // upstream keeps modifying src/a.ts (enough lines to clear the 10-line
    // threshold from seedCascadeRegistry's config).
    repo.checkout('upstream/main');
    const body = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n') + '\n';
    repo.write('src/a.ts', body);
    repo.commit('upstream: extend a');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.flsDeletionGroups.length).toBe(1);
    const g = r.flsDeletionGroups[0];
    expect(g.deletionSha).not.toBe('unknown');
    expect(g.deletionSubject).toBe('fls: remove legacy a');
    expect(g.files).toHaveLength(1);
    expect(g.files[0].path).toBe('src/a.ts');
    expect(g.files[0].upstreamAdded + g.files[0].upstreamRemoved).toBeGreaterThanOrEqual(10);
    expect(g.files[0].upstreamTouchingCommits.length).toBeGreaterThan(0);
  });

  it('groups multiple files deleted in the same fls commit together', () => {
    seedBase();
    // fls deletes two files in one commit.
    repo.run('rm', 'src/a.ts');
    repo.run('rm', 'src/b.ts');
    repo.commit('fls: remove legacy a and b');
    // upstream modifies both with enough lines.
    repo.checkout('upstream/main');
    const body = Array.from({ length: 15 }, (_, i) => `L${i}`).join('\n') + '\n';
    repo.write('src/a.ts', body);
    repo.commit('upstream: extend a');
    repo.write('src/b.ts', body);
    repo.commit('upstream: extend b');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.flsDeletionGroups.length).toBe(1);
    const g = r.flsDeletionGroups[0];
    expect(g.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('splits into separate groups when deletions happen in separate fls commits', () => {
    seedBase();
    repo.run('rm', 'src/a.ts');
    repo.commit('fls: remove a');
    repo.run('rm', 'src/b.ts');
    repo.commit('fls: remove b');
    repo.checkout('upstream/main');
    const body = Array.from({ length: 15 }, (_, i) => `L${i}`).join('\n') + '\n';
    repo.write('src/a.ts', body);
    repo.commit('upstream: edit a');
    repo.write('src/b.ts', body);
    repo.commit('upstream: edit b');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.flsDeletionGroups.length).toBe(2);
    expect(r.flsDeletionGroups[0].files).toHaveLength(1);
    expect(r.flsDeletionGroups[1].files).toHaveLength(1);
  });

  it('detects files upstream added in-range that fls never had (case 2: fls-absent, not fls-deleted)', () => {
    seedBase();
    // fls makes no changes. main stays at base.
    // upstream adds a new file that fls has never had.
    repo.checkout('upstream/main');
    const body = Array.from({ length: 15 }, (_, i) => `L${i}`).join('\n') + '\n';
    repo.write('src/new-upstream-only.ts', body);
    repo.commit('upstream: add skill file');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.flsDeletionGroups.length).toBe(1);
    const g = r.flsDeletionGroups[0];
    // No fls deletion commit — fls never had this file.
    expect(g.deletionSha).toBe('unknown');
    expect(g.files.map((f) => f.path)).toContain('src/new-upstream-only.ts');
  });

  it('filters out upstream deltas below the threshold', () => {
    seedBase();
    repo.run('rm', 'src/a.ts');
    repo.commit('fls: remove a');
    repo.checkout('upstream/main');
    // Only 1 line of change — below the 10-line threshold.
    repo.write('src/a.ts', 'a0\nadded\n');
    repo.commit('upstream: tiny edit');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.flsDeletionGroups).toHaveLength(0);
  });

  it('emits no groups when nothing fls deleted is modified upstream', () => {
    seedBase();
    repo.run('rm', 'src/a.ts');
    repo.commit('fls: remove a');
    repo.checkout('upstream/main');
    // Upstream edits a different file.
    repo.write('src/b.ts', 'b-changed\nmore\nlines\nand\nmore\nand\nmore\nand\nmore\nand\nmore\nand\n');
    repo.commit('upstream: edit b');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    expect(r.flsDeletionGroups).toHaveLength(0);
  });
});

describe('analyzeIntake — whitespace-only per-file signal', () => {
  it('is suppressed when config.intake_whitespace_only is false', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'x = 1;\n');
    repo.commit('set a');
    repo.write('src/a.ts', '  x = 1;\n');
    repo.commit('reformat a');
    repo.checkout('main');
    // Override config: whitespace signal off (e.g. Python project).
    const r = analyzeIntake({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
      config: {
        version_depth: 3,
        upstream_remote: 'upstream',
        upstream_main_branch: 'main',
        fls_deletion_min_lines: 10,
        intake_whitespace_only: false,
      },
    });
    for (const c of r.commits) {
      for (const f of c.files) {
        expect(f.whitespaceOnly).toBeUndefined();
      }
    }
  });

  it('flags a commit whose diff is pure whitespace', () => {
    seedBase();
    repo.checkout('upstream/main');
    // Two content lines on upstream as a baseline the formatter can churn.
    repo.write('src/a.ts', 'x = 1;\ny = 2;\n');
    repo.commit('upstream set a');
    // Pure whitespace touch: reformat to spaces only, no token changes.
    repo.write('src/a.ts', '  x = 1;\n  y = 2;\n');
    repo.commit('reformat a');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const reformat = r.commits.find((c) => c.subject === 'reformat a');
    expect(reformat).toBeDefined();
    const f = reformat!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f?.whitespaceOnly).toBe(true);
    // The content-bearing commit is not whitespace-only.
    const content = r.commits.find((c) => c.subject === 'upstream set a');
    const cf = content!.files.find((ff) => ff.path === 'src/a.ts');
    expect(cf?.whitespaceOnly).toBeUndefined();
  });
});

describe('analyzeIntake — revertedAt per-file signal', () => {
  it('flags a simple A→B→A revert pair', () => {
    seedBase();
    repo.checkout('upstream/main');
    // src/a.ts starts at 'a0\n' from base.
    repo.write('src/a.ts', 'a1\n');
    const c1 = repo.commit('move a to a1');
    repo.write('src/a.ts', 'a0\n'); // back to base content
    const c2 = repo.commit('revert a to a0');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const first = r.commits.find((c) => c.sha === c1);
    const reverter = r.commits.find((c) => c.sha === c2);
    const f = first!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f?.revertedAt).toBe(c2);
    // The reverter itself sits at the last position — no later match.
    const rf = reverter!.files.find((ff) => ff.path === 'src/a.ts');
    expect(rf?.revertedAt).toBeUndefined();
  });

  it('catches cumulative rollback: base → X → Y → base flags both X and Y touches', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'X\n');
    repo.commit('c1 to X');
    repo.write('src/a.ts', 'Y\n');
    repo.commit('c2 to Y');
    repo.write('src/a.ts', 'a0\n'); // back to base
    const c3 = repo.commit('c3 back to base');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const byName = new Map(r.commits.map((c) => [c.subject, c]));
    // c1's pre-state is 'a0\n' (base). Later state matches at c3.
    const f1 = byName.get('c1 to X')!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f1?.revertedAt).toBe(c3);
    // c2's pre-state is 'X\n'. Never recurs strictly after c2 — but the
    // sequence has a duplicate pair (base at state[0] and state[3]) that
    // covers c2's sequence position. Implementation finds the earliest j > k
    // where state[j] is any earlier state, which matches at j=3 → c3.
    const f2 = byName.get('c2 to Y')!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f2?.revertedAt).toBe(c3);
  });

  it('catches mid-range rollback not anchored to base (A, B, C, B, D)', () => {
    seedBase();
    repo.checkout('upstream/main');
    // Seed upstream to state B (distinct from base 'a0\n') via c1.
    repo.write('src/a.ts', 'B\n');
    repo.commit('c1 to B');
    repo.write('src/a.ts', 'C\n');
    repo.commit('c2 to C');
    repo.write('src/a.ts', 'B\n'); // back to B
    const c3 = repo.commit('c3 back to B');
    repo.write('src/a.ts', 'D\n');
    repo.commit('c4 to D');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    const byName = new Map(r.commits.map((c) => [c.subject, c]));
    // c1 pre-state = base 'a0\n'; never recurs → undefined.
    const f1 = byName.get('c1 to B')!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f1?.revertedAt).toBeUndefined();
    // c2 pre-state = B; recurs at c3.
    const f2 = byName.get('c2 to C')!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f2?.revertedAt).toBe(c3);
    // c4 is the last toucher — nothing later.
    const f4 = byName.get('c4 to D')!.files.find((ff) => ff.path === 'src/a.ts');
    expect(f4?.revertedAt).toBeUndefined();
  });

  it('does not flag when the path never returns to any prior state', () => {
    seedBase();
    repo.checkout('upstream/main');
    repo.write('src/a.ts', 'v1\n');
    repo.commit('to v1');
    repo.write('src/a.ts', 'v2\n');
    repo.commit('to v2');
    repo.checkout('main');
    const r = analyzeIntake({ repoRoot: repo.root, target: 'main', source: 'upstream/main' });
    for (const c of r.commits) {
      for (const f of c.files) {
        expect(f.revertedAt).toBeUndefined();
      }
    }
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
