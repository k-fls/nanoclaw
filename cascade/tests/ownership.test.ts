import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  deriveOwnership,
  formatOwnershipMap,
  loadOwnershipOverrides,
  loadOwnershipRules,
} from '../scripts/ownership.js';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { makeRepo, seedCascadeRegistry, Repo } from './fixtures.js';

let repo: Repo;
beforeEach(() => {
  repo = makeRepo('cascade-own-');
  seedCascadeRegistry(repo.root);
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

describe('loadOwnershipRules', () => {
  it('parses committed rules', () => {
    const { raw } = loadOwnershipRules(repo.root);
    expect(raw).toContain('node_modules/');
    expect(raw).toContain('package-lock.json');
  });
});

describe('deriveOwnership — Stage 3 upstream-reachability', () => {
  it('attributes a file to core when the intro commit lives only on upstream (mid-intake scratch branch)', () => {
    // Baseline commit shared between main and upstream/main.
    repo.write('README.md', '# r\n');
    repo.commit('base');
    repo.run('branch', 'upstream/main');
    // Upstream introduces a file; fls has NOT intaken yet.
    repo.checkout('upstream/main');
    repo.write('src/upstream-only.ts', 'u\n');
    repo.commit('upstream: add file');
    // Scratch-branch intake pattern: we check out a non-main branch and merge
    // upstream into it. main's ref hasn't moved.
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'intake-scratch');
    repo.merge('upstream/main', 'intake upstream on scratch');
    // The file is now in the working tree. main/core's ref is still at
    // "base". Stage 1 and Stage 2 don't match (scratch is ephemeral,
    // filtered out). Stage 3 kicks in: the intro commit is reachable from
    // upstream/main → owner = main (core's canonical branch).
    const r = deriveOwnership({ repoRoot: repo.root });
    const e = r.entries.find((x) => x.path === 'src/upstream-only.ts');
    expect(e?.owner).toBe('main');
    expect(r.unowned).not.toContain('src/upstream-only.ts');
  });

  it('still prefers direct first-parent attribution over the upstream fallback', () => {
    repo.write('README.md', '# r\n');
    repo.commit('base');
    repo.run('branch', 'upstream/main');
    // Normal case: file is introduced on main directly. Stage 1 wins; Stage 3
    // is not even consulted.
    repo.write('src/fls-local.ts', 'f\n');
    repo.commit('fls: add file');
    const r = deriveOwnership({ repoRoot: repo.root });
    const e = r.entries.find((x) => x.path === 'src/fls-local.ts');
    expect(e?.owner).toBe('main');
  });
});

describe('deriveOwnership — attribution', () => {
  it('attributes a file introduced on main to core', () => {
    repo.write('src/a.ts', 'export const A = 1;\n');
    repo.commit('core: add A');
    const r = deriveOwnership({ repoRoot: repo.root });
    const e = r.entries.find((x) => x.path === 'src/a.ts');
    expect(e?.owner).toBe('main');
  });

  it('attributes a module-introduced file to the module, even after merge to core', () => {
    // Seed main with a baseline commit.
    repo.write('README.md', '# test\n');
    repo.commit('core: init');
    // Branch module/foo from main; add a file; merge back.
    repo.branch('module/foo');
    repo.checkout('module/foo');
    repo.write('src/module.ts', 'export const M = 1;\n');
    repo.commit('module: add M');
    repo.checkout('main');
    repo.merge('module/foo');
    const r = deriveOwnership({ repoRoot: repo.root });
    const e = r.entries.find((x) => x.path === 'src/module.ts');
    expect(e?.owner).toBe('module/foo');
  });

  it('attributes a core commit to core even when module/foo has been branched', () => {
    repo.write('README.md', '# x\n');
    repo.commit('core: init');
    repo.write('src/core.ts', 'export const C = 1;\n');
    const coreCommit = repo.commit('core: add C');
    repo.branch('module/foo', coreCommit);
    // Touch module to make sure it's distinct from main, but don't modify core.ts.
    repo.checkout('module/foo');
    repo.write('src/module.ts', 'export const M = 1;\n');
    repo.commit('module: init');
    repo.checkout('main');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.entries.find((x) => x.path === 'src/core.ts')?.owner).toBe('main');
  });

  it('marks project-owned files per ownership_rules', () => {
    repo.write('package-lock.json', '{"a":1}\n');
    repo.commit('add lockfile');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.entries.find((x) => x.path === 'package-lock.json')?.owner).toBe('project');
  });

  it('attributes an ephemeral-introduced file to the long-lived branch that absorbed it', () => {
    repo.write('seed.md', '# seed\n');
    repo.commit('core: init');
    repo.branch('feature/x');
    repo.checkout('feature/x');
    repo.write('src/eph.ts', 'export const E = 1;\n');
    repo.commit('feature: add E');
    repo.checkout('main');
    repo.merge('feature/x');
    const r = deriveOwnership({ repoRoot: repo.root });
    // Ephemerals are never candidate owners → first long-lived whose ancestry
    // contains the commit (main, via the merge).
    expect(r.entries.find((x) => x.path === 'src/eph.ts')?.owner).toBe('main');
  });
});

describe('deriveOwnership — renames', () => {
  it('treats a rename as a fresh introduction at the new path', () => {
    // Per cascade/docs/ownership.md: "Renames are introductions at the new
    // path. No --follow. A rename = new introduction; the branch performing
    // the rename owns the file at its new path."
    repo.write('seed.md', '# s\n');
    repo.commit('core: init');
    repo.write('src/legacy.ts', 'export const L = 1;\n');
    repo.commit('core: add legacy');
    repo.branch('module/foo');
    repo.checkout('module/foo');
    repo.run('mv', 'src/legacy.ts', 'src/renamed.ts');
    repo.commit('module: rename legacy to renamed');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.entries.find((x) => x.path === 'src/renamed.ts')?.owner).toBe(
      'module/foo',
    );
    expect(r.entries.find((x) => x.path === 'src/legacy.ts')).toBeUndefined();
  });

  it('suppresses rename-induced double-introduction warnings', () => {
    // Setup: file added on main, renamed on main, then a downstream branch
    // independently re-creates the renamed path (e.g. via cherry-pick or
    // a single-parent rebase). Under --no-renames both the rename commit
    // and the re-add commit appear as introducers of the new path on
    // independent timelines — but it's not a real double-authoring; the
    // rename heuristic recognizes one of them as a `git mv`. Warning
    // should be suppressed; renamePairs should still list the event.
    repo.write('seed.md', '# s\n');
    repo.commit('core: init');
    repo.write('a.ts', '1\n');
    repo.commit('core: add a');
    repo.run('mv', 'a.ts', 'b.ts');
    repo.commit('core: rename a to b');
    repo.branch('skill/oauth');
    repo.checkout('skill/oauth');
    // Independent re-add of b.ts on the downstream branch (different
    // content, no rename relation to anything on this branch).
    repo.write('b.ts', '2\n');
    // Force a fresh add-commit. Use --allow-empty-message? No — just commit.
    repo.run('add', 'b.ts');
    repo.run('commit', '-q', '-m', 'oauth: re-add b');
    const r = deriveOwnership({ repoRoot: repo.root });
    // Double-intro warning suppressed because b.ts has a rename event whose
    // commit is one of its introducers.
    expect(r.doubleIntroductions.find((d) => d.path === 'b.ts')).toBeUndefined();
  });

  it('rename attribution is independent of git rename-detection config', () => {
    // Determinism: enabling diff.renames must not change ownership output.
    repo.run('config', 'diff.renames', 'true');
    repo.write('seed.md', '# s\n');
    repo.commit('core: init');
    repo.write('a.ts', '1\n');
    repo.commit('core: add a');
    repo.branch('module/foo');
    repo.checkout('module/foo');
    repo.run('mv', 'a.ts', 'b.ts');
    repo.commit('module: rename a to b');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.entries.find((x) => x.path === 'b.ts')?.owner).toBe('module/foo');
  });
});

describe('deriveOwnership — determinism + format', () => {
  it('produces byte-identical output across runs', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('add a');
    repo.branch('module/foo');
    repo.checkout('module/foo');
    repo.write('b.ts', 'b\n');
    repo.commit('module: add b');
    repo.checkout('main');
    repo.merge('module/foo');
    const a = formatOwnershipMap(deriveOwnership({ repoRoot: repo.root }));
    const b = formatOwnershipMap(deriveOwnership({ repoRoot: repo.root }));
    expect(a).toBe(b);
  });

  it('entries sorted by path', () => {
    repo.write('z.ts', 'z\n');
    repo.write('a.ts', 'a\n');
    repo.write('m.ts', 'm\n');
    repo.commit('add files');
    const r = deriveOwnership({ repoRoot: repo.root });
    const paths = r.entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(paths);
  });
});

describe('deriveOwnership — ownership_overrides', () => {
  function writeOverrides(content: string) {
    writeFileSync(path.join(repo.root, '.cascade', 'ownership_overrides'), content);
  }

  it('absent file → empty override map', () => {
    const m = loadOwnershipOverrides(repo.root);
    expect(m.size).toBe(0);
  });

  it('override wins over mechanical attribution', () => {
    // File introduced on module/foo; without override, module/foo owns.
    repo.write('README.md', '# seed\n');
    repo.commit('init');
    repo.branch('module/foo');
    repo.checkout('module/foo');
    repo.write('src/ambiguous.ts', 'x\n');
    repo.commit('module: add ambiguous');
    repo.checkout('main');
    repo.merge('module/foo');

    // Confirm baseline: module/foo owns.
    const baseline = deriveOwnership({ repoRoot: repo.root });
    expect(baseline.entries.find((e) => e.path === 'src/ambiguous.ts')?.owner).toBe('module/foo');

    // Add override → main owns.
    writeOverrides('src/ambiguous.ts  main\n');
    const after = deriveOwnership({ repoRoot: repo.root });
    expect(after.entries.find((e) => e.path === 'src/ambiguous.ts')?.owner).toBe('main');
    expect(after.overridden).toContain('src/ambiguous.ts');
  });

  it('override suppresses double-introduction for the overridden path', () => {
    // Distinct content on each branch and a third post-merge content so
    // neither content-equivalence nor reconciled-divergence suppresses
    // the warning. The override is the only thing that can silence it.
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('checkout', '-q', '-b', 'fa');
    repo.write('dup.ts', 'alpha\n');
    repo.commit('a');
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'fb');
    repo.write('dup.ts', 'beta\n');
    repo.commit('b');
    repo.checkout('main');
    repo.merge('fa');
    try {
      repo.merge('fb');
    } catch {
      repo.write('dup.ts', 'gamma\n'); // third version — neither intro
      repo.run('add', 'dup.ts');
      repo.run('commit', '-q', '--no-edit');
    }

    const before = deriveOwnership({ repoRoot: repo.root });
    expect(before.doubleIntroductions.find((d) => d.path === 'dup.ts')).toBeDefined();

    writeOverrides('dup.ts  main\n');
    const after = deriveOwnership({ repoRoot: repo.root });
    expect(after.doubleIntroductions.find((d) => d.path === 'dup.ts')).toBeUndefined();
  });

  it('suppresses double-introduction when current tree blob matches one introducer (reconciled divergence)', () => {
    // Two branches add the file with different content. Later, the tree
    // converges on one of the two introduced versions (e.g. someone
    // resolved the divergence by overwriting). Warning is suppressed
    // because the divergence is no longer actionable — the surviving
    // content matches an original introduction.
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('checkout', '-q', '-b', 'fa');
    repo.write('div.ts', 'alpha\n');
    repo.commit('a');
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'fb');
    repo.write('div.ts', 'beta\n');
    repo.commit('b');
    repo.checkout('main');
    repo.merge('fa');
    try {
      repo.merge('fb');
    } catch {
      // Conflict resolved in favor of fa's content (alpha) — matches an
      // intro blob, divergence reconciled.
      repo.write('div.ts', 'alpha\n');
      repo.run('add', 'div.ts');
      repo.run('commit', '-q', '--no-edit');
    }
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.doubleIntroductions.find((d) => d.path === 'div.ts')).toBeUndefined();
  });

  it('keeps double-introduction warning when tree blob differs from all introducers', () => {
    // Two distinct blobs introduced; tree later diverged from both (e.g.
    // someone edited the file post-merge to a third version). The warning
    // remains — divergence is real and the resolution is unclear.
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('checkout', '-q', '-b', 'fa');
    repo.write('div.ts', 'alpha\n');
    repo.commit('a');
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'fb');
    repo.write('div.ts', 'beta\n');
    repo.commit('b');
    repo.checkout('main');
    repo.merge('fa');
    try {
      repo.merge('fb');
    } catch {
      repo.write('div.ts', 'gamma\n'); // third version, neither intro
      repo.run('add', 'div.ts');
      repo.run('commit', '-q', '--no-edit');
    }
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.doubleIntroductions.find((d) => d.path === 'div.ts')).toBeDefined();
  });

  it('suppresses double-introduction when all introducing commits store the same blob', () => {
    // Two branches add the file with byte-identical content. Without
    // suppression, this fires a double-intro warning. With blob-equality
    // suppression, the warning is silenced — the same content traveling
    // via cherry-pick / squash is not a real second authoring.
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('checkout', '-q', '-b', 'fa');
    repo.write('same.ts', 'identical\n');
    repo.commit('a');
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'fb');
    repo.write('same.ts', 'identical\n');
    repo.commit('b');
    repo.checkout('main');
    repo.merge('fa');
    repo.merge('fb');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.doubleIntroductions.find((d) => d.path === 'same.ts')).toBeUndefined();
  });

  it('flags an override whose owner is not a long-lived branch', () => {
    repo.write('x.ts', 'x\n');
    repo.commit('init');
    writeOverrides('x.ts  feature/nope\n');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.invalidOverrides).toHaveLength(1);
    expect(r.invalidOverrides[0].owner).toBe('feature/nope');
    // Invalid override is dropped; file falls back to mechanical attribution.
    expect(r.entries.find((e) => e.path === 'x.ts')?.owner).not.toBe('feature/nope');
  });

  it('flags a redundant override (derivation would produce the same result)', () => {
    repo.write('r.ts', 'r\n');
    repo.commit('init');
    // Mechanical attribution: main. Declaring main is redundant.
    writeOverrides('r.ts  main\n');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.redundantOverrides).toHaveLength(1);
    expect(r.redundantOverrides[0].path).toBe('r.ts');
  });

  it('flags a redundant override on a suppressed double-intro path', () => {
    // The path has two introducing commits with identical content
    // (content-equivalent suppression silences the double-intro warning).
    // Mechanical derivation produces `main` via the independent-timeline
    // tiebreak. Declaring `main` is therefore redundant — the override is
    // not load-bearing for warning suppression (the blob-equality rule is)
    // and it matches what derivation would produce anyway.
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('checkout', '-q', '-b', 'fa');
    repo.write('same.ts', 'same\n');
    repo.commit('a');
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'fb');
    repo.write('same.ts', 'same\n');
    repo.commit('b');
    repo.checkout('main');
    repo.merge('fa');
    repo.merge('fb');
    writeOverrides('same.ts  main\n');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.doubleIntroductions.find((d) => d.path === 'same.ts')).toBeUndefined();
    expect(r.redundantOverrides.find((o) => o.path === 'same.ts')?.owner).toBe('main');
  });

  it('throws on malformed line', () => {
    writeOverrides('onlypath\n');
    expect(() => loadOwnershipOverrides(repo.root)).toThrow(/malformed/i);
  });

  it('throws on duplicate entry', () => {
    writeOverrides('a.ts  main\na.ts  main\n');
    expect(() => loadOwnershipOverrides(repo.root)).toThrow(/duplicate/i);
  });
});

describe('deriveOwnership — dead rules', () => {
  it('flags patterns that match nothing', () => {
    repo.write('src/a.ts', 'x\n');
    repo.commit('core: init');
    const r = deriveOwnership({ repoRoot: repo.root });
    // Seeded rules include `node_modules/` and `package-lock.json`; neither
    // is committed in this fixture.
    expect(r.deadRules).toContain('node_modules/');
    expect(r.deadRules).toContain('package-lock.json');
  });

  it('does not flag a rule that matches', () => {
    repo.write('package-lock.json', '{}\n');
    repo.commit('add lock');
    const r = deriveOwnership({ repoRoot: repo.root });
    expect(r.deadRules).not.toContain('package-lock.json');
  });
});
