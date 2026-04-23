import { describe, expect, it } from 'vitest';
import { runCheck } from '../scripts/check.js';
import { writeTag } from '../scripts/tags.js';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';

function setup() {
  const r = makeRepo();
  seedCascadeRegistry(r.root);
  r.write('r', 'r\n');
  r.commit('init');
  // Rename main -> core.
  r.run('branch', '-m', 'main', 'core');
  return r;
}

describe('tag-naming', () => {
  it('passes on cleanly-shaped cascade tag', () => {
    const r = setup();
    writeTag({ branch: 'core', version: { a: 1, b: 0, c: 0, d: 1 } }, r.root);
    const res = runCheck({ repoRoot: r.root, writeMap: false });
    expect(res.violations.find((v) => v.rule === 'tag-naming')).toBeUndefined();
  });

  it('fires on core/foo (non-version shape)', () => {
    const r = setup();
    // Tag directly (not via writeTag, which would reject the shape).
    r.run('tag', '-a', 'core/foo', '-m', 'bad');
    const res = runCheck({ repoRoot: r.root, writeMap: false });
    const v = res.violations.find((v) => v.rule === 'tag-naming');
    expect(v).toBeDefined();
    expect(v!.message).toContain('core/foo');
  });

  it('ignores unrelated tags (upstream-style)', () => {
    const r = setup();
    r.run('tag', '-a', 'v1.2.3', '-m', 'u');
    const res = runCheck({ repoRoot: r.root, writeMap: false });
    expect(res.violations.find((v) => v.rule === 'tag-naming')).toBeUndefined();
  });
});

describe('tag-monotonicity', () => {
  it('passes on monotonic sequence', () => {
    const r = setup();
    writeTag({ branch: 'core', version: { a: 1, b: 0, c: 0, d: 1 } }, r.root);
    r.write('a', 'a\n');
    r.commit('a');
    writeTag({ branch: 'core', version: { a: 1, b: 0, c: 0, d: 2 } }, r.root);
    const res = runCheck({ repoRoot: r.root, writeMap: false });
    expect(res.violations.find((v) => v.rule === 'tag-monotonicity')).toBeUndefined();
  });

  it('fires when a later commit has a lower version', () => {
    const r = setup();
    // Tag D=5 first, advance, then tag D=2 (out of order).
    writeTag({ branch: 'core', version: { a: 1, b: 0, c: 0, d: 5 } }, r.root);
    r.write('a', 'a\n');
    r.commit('a');
    // Force-write a lower version at the newer commit via raw git (writeTag
    // has no overwrite or ordering guard; name is new so it accepts).
    r.run('tag', '-a', 'core/1.0.0.2', '-m', 'lower');
    const res = runCheck({ repoRoot: r.root, writeMap: false });
    const v = res.violations.find((v) => v.rule === 'tag-monotonicity');
    expect(v).toBeDefined();
    expect(v!.message).toContain('smaller');
  });
});
