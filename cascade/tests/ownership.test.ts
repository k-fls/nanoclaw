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
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('checkout', '-q', '-b', 'fa');
    repo.write('dup.ts', 'same\n');
    repo.commit('a');
    repo.run('checkout', '-q', 'main');
    repo.run('checkout', '-q', '-b', 'fb');
    repo.write('dup.ts', 'same\n');
    repo.commit('b');
    repo.checkout('main');
    repo.merge('fa');
    repo.merge('fb'); // identical content, no conflict

    const before = deriveOwnership({ repoRoot: repo.root });
    expect(before.doubleIntroductions.find((d) => d.path === 'dup.ts')).toBeDefined();

    writeOverrides('dup.ts  main\n');
    const after = deriveOwnership({ repoRoot: repo.root });
    expect(after.doubleIntroductions.find((d) => d.path === 'dup.ts')).toBeUndefined();
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
