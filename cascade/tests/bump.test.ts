import { describe, expect, it } from 'vitest';
import {
  NoPriorTagError,
  SeedRejectedError,
  SourceTagMissingError,
  firstBumpBaseline,
  loadConfig,
  planBump,
} from '../scripts/version.js';
import { loadRegistry } from '../scripts/branch-graph.js';
import { writeTag } from '../scripts/tags.js';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';

function setupCore(): ReturnType<typeof makeRepo> {
  const r = makeRepo();
  seedCascadeRegistry(r.root);
  r.write('README.md', 'r\n');
  r.commit('init');
  // Create an `upstream/main` branch as a stand-in for the upstream remote.
  r.run('checkout', '-b', 'upstream/main');
  r.write('up.txt', 'u1\n');
  r.commit('up1');
  r.run('tag', '-a', 'v1.9.0', '-m', 'u190');
  r.write('up.txt', 'u2\n');
  r.commit('up2');
  // core branches off upstream at v1.9.0.
  r.run('checkout', '-b', 'core', 'v1.9.0');
  r.write('core.txt', 'c\n');
  r.commit('core-work');
  return r;
}

describe('firstBumpBaseline', () => {
  it('core: finds upstream tag at merge-base', () => {
    const r = setupCore();
    const registry = loadRegistry(r.root);
    const config = loadConfig(r.root);
    const base = firstBumpBaseline('core', r.root, registry, config);
    expect(base.kind).toBe('ok');
    if (base.kind === 'ok') {
      expect(base.baseline).toEqual({ a: 1, b: 9, c: 0, d: 0 });
    }
  });

  it('reports source-tag-missing when source has no tags at merge-base', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    r.write('README.md', 'r\n');
    r.commit('init');
    r.run('checkout', '-b', 'upstream/main');
    r.write('u.txt', 'u\n');
    r.commit('up');
    r.run('checkout', '-b', 'core');
    r.write('c.txt', 'c\n');
    r.commit('c');
    const registry = loadRegistry(r.root);
    const config = loadConfig(r.root);
    const base = firstBumpBaseline('core', r.root, registry, config);
    expect(base.kind).toBe('source-tag-missing');
  });
});

describe('planBump', () => {
  it('first-bump-from-baseline on core', () => {
    const r = setupCore();
    const res = planBump('core', r.root);
    expect(res.kind).toBe('bump');
    if (res.kind === 'bump') {
      expect(res.reason).toBe('first-bump-from-baseline');
      expect(res.next).toEqual({ a: 1, b: 9, c: 0, d: 1 });
    }
  });

  it('noop when target unchanged since last tag and prefix stable', () => {
    const r = setupCore();
    const plan = planBump('core', r.root);
    if (plan.kind !== 'bump') throw new Error('expected bump');
    writeTag({ branch: 'core', version: plan.next, notes: 'first' }, r.root);
    const second = planBump('core', r.root);
    expect(second.kind).toBe('noop');
  });

  it('target-advanced: D++ when target moves but source prefix stable', () => {
    const r = setupCore();
    const first = planBump('core', r.root);
    if (first.kind !== 'bump') throw new Error('expected bump');
    writeTag({ branch: 'core', version: first.next }, r.root);
    r.write('core.txt', 'more\n');
    r.commit('more core work');
    const next = planBump('core', r.root);
    expect(next.kind).toBe('bump');
    if (next.kind === 'bump') {
      expect(next.reason).toBe('target-advanced');
      expect(next.next).toEqual({ a: 1, b: 9, c: 0, d: 2 });
    }
  });

  it('prefix-advanced: resets D to 1 when source prefix jumps', () => {
    const r = setupCore();
    const first = planBump('core', r.root);
    if (first.kind !== 'bump') throw new Error('expected bump');
    writeTag({ branch: 'core', version: first.next }, r.root);
    // Upstream releases 1.10.0 and core merges it.
    r.run('checkout', 'upstream/main');
    r.write('up.txt', 'u3\n');
    r.commit('up3');
    r.run('tag', '-a', 'v1.10.0', '-m', 'u1100');
    r.run('checkout', 'core');
    r.run('merge', '--no-ff', '-m', 'merge upstream 1.10.0', 'upstream/main');
    const next = planBump('core', r.root);
    expect(next.kind).toBe('bump');
    if (next.kind === 'bump') {
      expect(next.reason).toBe('prefix-advanced');
      expect(next.next).toEqual({ a: 1, b: 10, c: 0, d: 1 });
    }
  });

  it('--seed accepted when source has no tag at merge-base', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    r.write('r', 'r\n');
    r.commit('init');
    r.run('checkout', '-b', 'upstream/main');
    r.write('u', 'u\n');
    r.commit('up');
    r.run('checkout', '-b', 'core');
    r.write('c', 'c\n');
    r.commit('c');
    const res = planBump('core', r.root, { seed: { a: 1, b: 0, c: 0, d: 1 } });
    expect(res.kind).toBe('bump');
    if (res.kind === 'bump') {
      expect(res.reason).toBe('first-bump-from-seed');
      expect(res.next).toEqual({ a: 1, b: 0, c: 0, d: 1 });
    }
  });

  it('--seed rejected when baseline is derivable', () => {
    const r = setupCore();
    expect(() =>
      planBump('core', r.root, { seed: { a: 2, b: 0, c: 0, d: 0 } }),
    ).toThrow(SeedRejectedError);
  });

  it('--seed rejected when prior tag exists (even without value mismatch)', () => {
    const r = setupCore();
    const first = planBump('core', r.root);
    if (first.kind !== 'bump') throw new Error('expected bump');
    writeTag({ branch: 'core', version: first.next }, r.root);
    expect(() =>
      planBump('core', r.root, { seed: { a: 1, b: 9, c: 0, d: 2 } }),
    ).toThrow(SeedRejectedError);
  });

  it('raises SourceTagMissingError without --seed when source has no tag', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    r.write('r', 'r\n');
    r.commit('init');
    r.run('checkout', '-b', 'upstream/main');
    r.write('u', 'u\n');
    r.commit('up');
    r.run('checkout', '-b', 'core');
    r.write('c', 'c\n');
    r.commit('c');
    expect(() => planBump('core', r.root)).toThrow(SourceTagMissingError);
  });

  it('refuses ephemeral branches', () => {
    const r = setupCore();
    r.run('checkout', '-b', 'hotfix/bug');
    expect(() => planBump('hotfix/bug', r.root)).toThrow(/ephemeral/);
  });

  it('refuses not_versioned branches (channels and modules)', () => {
    const r = setupCore();
    r.run('checkout', '-b', 'channel/telegram', 'core');
    expect(() => planBump('channel/telegram', r.root)).toThrow(/not versioned/);
    r.run('checkout', '-b', 'module/foo', 'core');
    expect(() => planBump('module/foo', r.root)).toThrow(/not versioned/);
  });
});
