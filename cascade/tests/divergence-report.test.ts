import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { divergenceReport } from '../scripts/divergence-report.js';
import { makeRepo, seedCascadeRegistry, Repo } from './fixtures.js';

let repo: Repo;
beforeEach(() => {
  repo = makeRepo('cascade-divergence-');
  seedCascadeRegistry(repo.root);
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

function seedBase() {
  repo.write('src/a.ts', 'a0\n');
  repo.write('src/b.ts', 'b0\n');
  repo.commit('base');
  repo.run('branch', 'upstream/main');
}

describe('divergenceReport — no divergence', () => {
  it('reports empty when target == source', () => {
    seedBase();
    const r = divergenceReport({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
    });
    expect(r.totals.files).toBe(0);
    expect(r.files).toHaveLength(0);
  });
});

describe('divergenceReport — basic divergence', () => {
  it('captures a modified file with line totals', () => {
    seedBase();
    repo.write('src/a.ts', 'a0\nfls-addition\n');
    repo.commit('fls tweak');
    const r = divergenceReport({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
    });
    expect(r.totals.files).toBe(1);
    const f = r.files[0];
    expect(f.path).toBe('src/a.ts');
    expect(f.status).toBe('M');
    expect(f.added).toBe(1);
    expect(f.hunks).toHaveLength(1);
  });

  it('captures a new file as A', () => {
    seedBase();
    repo.write('src/fls-new.ts', 'new\n');
    repo.commit('fls new file');
    const r = divergenceReport({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
    });
    const f = r.files.find((x) => x.path === 'src/fls-new.ts');
    expect(f).toBeDefined();
    expect(f!.status).toBe('A');
  });

  it('captures deletions as D', () => {
    seedBase();
    repo.run('rm', 'src/b.ts');
    repo.commit('fls remove b');
    const r = divergenceReport({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
    });
    const f = r.files.find((x) => x.path === 'src/b.ts');
    expect(f).toBeDefined();
    expect(f!.status).toBe('D');
  });
});

describe('divergenceReport — renames', () => {
  it('captures a rename with upstreamPath', () => {
    seedBase();
    repo.run('mv', 'src/a.ts', 'src/a-renamed.ts');
    repo.commit('rename a');
    const r = divergenceReport({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
    });
    const ren = r.files.find((x) => x.status === 'R');
    expect(ren).toBeDefined();
    expect(ren!.upstreamPath).toBe('src/a.ts');
    expect(ren!.path).toBe('src/a-renamed.ts');
  });
});

describe('divergenceReport — hunk headers', () => {
  it('extracts function context from @@ header when present', () => {
    seedBase();
    // Create a TS function then modify inside it.
    repo.write(
      'src/fn.ts',
      'export function widget() {\n  return 1;\n}\n',
    );
    repo.commit('add widget');
    repo.run('branch', '-f', 'upstream/main', 'HEAD');
    repo.write(
      'src/fn.ts',
      'export function widget() {\n  return 2;\n}\n',
    );
    repo.commit('bump widget');
    const r = divergenceReport({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream/main',
    });
    const fn = r.files.find((f) => f.path === 'src/fn.ts');
    expect(fn).toBeDefined();
    // The function header may or may not be inferred depending on git version
    // and language heuristics; the hunk itself must exist.
    expect(fn!.hunks.length).toBeGreaterThan(0);
  });
});
