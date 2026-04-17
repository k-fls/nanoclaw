import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { formatReport, runCheck, runSelfTest } from '../scripts/check.js';
import { makeRepo, seedCascadeRegistry, Repo } from './fixtures.js';

let repo: Repo;
beforeEach(() => {
  repo = makeRepo('cascade-check-');
  seedCascadeRegistry(repo.root);
});
afterEach(() => {
  rmSync(repo.root, { recursive: true, force: true });
});

describe('runSelfTest (prefix-mismatch fixture)', () => {
  it('all synthetic cases pass', () => {
    const r = runSelfTest();
    expect(r.failed).toEqual([]);
    expect(r.passed).toBeGreaterThanOrEqual(4);
  });
});

describe('runCheck — clean repo', () => {
  it('passes with no errors on a minimal clean repo', () => {
    repo.write('README.md', '# hi\n');
    repo.commit('init');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    expect(r.errors).toBe(0);
  });
});

describe('runCheck — squash marker detection', () => {
  it('flags a commit whose subject contains (squashed)', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('add a (squashed)');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const squash = r.violations.filter((v) => v.rule === 'merge-preserve');
    expect(squash.length).toBeGreaterThan(0);
    expect(squash[0].severity).toBe('warning');
  });
});

describe('runCheck — bypass log', () => {
  it('errors on malformed bypass-log entry', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('init');
    appendFileSync(path.join(repo.root, '.cascade', 'bypass-log'), 'nope\n');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const bl = r.violations.filter((v) => v.rule === 'bypass-log');
    expect(bl.length).toBe(1);
    expect(bl[0].severity).toBe('error');
  });

  it('suppresses warnings for rules listed in bypass-log', () => {
    repo.write('a.ts', 'a\n');
    const c = repo.commit('add a (squashed)');
    appendFileSync(
      path.join(repo.root, '.cascade', 'bypass-log'),
      `${c}  2026-04-17  main  merge-preserve  acknowledged\n`,
    );
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const squashKept = r.violations.filter((v) => v.rule === 'merge-preserve');
    const squashBypassed = r.bypassed.filter((v) => v.rule === 'merge-preserve');
    expect(squashKept.length).toBe(0);
    expect(squashBypassed.length).toBeGreaterThan(0);
  });
});

describe('runCheck — upstream/* policy entry', () => {
  // Helper: add the same file (identical content) on two independent branches
  // off `base`, merge both back into `base`, and return the two intro commits.
  // Identical content keeps the merge conflict-free while still producing two
  // distinct introducing commits for the same path.
  function doubleIntroduce(base: string, filename: string, content: string) {
    const brA = `feat-a-${filename.replace(/[^a-z]/gi, '')}`;
    const brB = `feat-b-${filename.replace(/[^a-z]/gi, '')}`;
    repo.run('checkout', '-q', base);
    repo.run('checkout', '-q', '-b', brA);
    repo.write(filename, content);
    const a = repo.commit(`intro ${filename} (A)`);
    repo.run('checkout', '-q', base);
    repo.run('checkout', '-q', '-b', brB);
    repo.write(filename, content);
    const b = repo.commit(`intro ${filename} (B)`);
    repo.checkout(base);
    repo.merge(brA);
    repo.merge(brB); // same content → no conflict
    return { a, b };
  }

  it('suppresses a double-introduction whose commits are all upstream-reachable', () => {
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    // "upstream/main" is a local branch here — loadUpstreamSet resolves any
    // ref matching config's upstream_remote/upstream_main_branch.
    repo.run('branch', 'upstream/main');
    doubleIntroduce('upstream/main', 'upstream-shared.ts', 'same\n');
    // Intake: bring upstream into main so its ownership map sees the path.
    repo.checkout('main');
    repo.merge('upstream/main', 'intake upstream');

    // Without the policy entry: double-introduction is flagged.
    const before = runCheck({ repoRoot: repo.root, writeMap: false });
    expect(before.violations.filter((v) => v.rule === 'double-introduction').length).toBeGreaterThan(0);

    // With the policy entry: same violation is bypassed.
    appendFileSync(
      path.join(repo.root, '.cascade', 'bypass-log'),
      `upstream/*  2026-04-17  main  double-introduction  policy: upstream is out of scope\n`,
    );
    const after = runCheck({ repoRoot: repo.root, writeMap: false });
    expect(after.violations.filter((v) => v.rule === 'double-introduction').length).toBe(0);
    expect(after.bypassed.filter((v) => v.rule === 'double-introduction').length).toBeGreaterThan(0);
  });

  it('does not suppress an fls-only double-introduction', () => {
    repo.write('README.md', '# seed\n');
    repo.commit('seed');
    repo.run('branch', 'upstream/main');
    // Introductions happen entirely on main's side — not reachable from upstream.
    doubleIntroduce('main', 'fls-only.ts', 'x\n');

    appendFileSync(
      path.join(repo.root, '.cascade', 'bypass-log'),
      `upstream/*  2026-04-17  main  double-introduction  policy\n`,
    );
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    expect(r.violations.filter((v) => v.rule === 'double-introduction').length).toBeGreaterThan(0);
  });
});

describe('runCheck — severity model', () => {
  it('dead-rule reports at info severity (not warning)', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('init');
    // seedCascadeRegistry adds `node_modules/` and `package-lock.json` as
    // rules; neither is committed here, so both are dead.
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const dead = r.violations.filter((v) => v.rule === 'dead-rule');
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((v) => v.severity === 'info')).toBe(true);
    // Dead rules must not contribute to the warning tally.
    const warningsFromDead = r.violations.filter(
      (v) => v.severity === 'warning' && v.rule === 'dead-rule',
    );
    expect(warningsFromDead).toHaveLength(0);
    expect(r.infos).toBeGreaterThan(0);
  });

  it('hygiene violation: safety-net pattern matches a committed file', () => {
    // Rewrite ownership_rules: package-lock.json is project-owned, dist/ is
    // safety-net (`?` prefix).
    writeFileSync(
      `${repo.root}/.cascade/ownership_rules`,
      `package-lock.json\n?dist/\n`,
    );
    repo.write('dist/bundle.js', 'oops\n');
    repo.commit('init');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const hyg = r.violations.filter((v) => v.rule === 'hygiene');
    expect(hyg.length).toBe(1);
    expect(hyg[0].severity).toBe('warning');
    expect(hyg[0].message).toContain('dist/bundle.js');
  });

  it('project-owned pattern that matches a committed file is NOT a hygiene violation', () => {
    repo.write('package-lock.json', '{}\n');
    repo.commit('add lock');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    expect(r.violations.filter((v) => v.rule === 'hygiene').length).toBe(0);
  });
});

describe('formatReport — redundant-override notice', () => {
  it('shows a notice line when redundant overrides are present (non-verbose)', () => {
    repo.write('r.ts', 'r\n');
    repo.commit('init');
    writeFileSync(`${repo.root}/.cascade/ownership_overrides`, 'r.ts  main\n');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const out = formatReport(r, { strict: false, verbose: false });
    expect(out).toContain('notice:');
    expect(out).toMatch(/1 override\(s\) appear redundant/);
  });

  it('does NOT show the notice when no overrides are redundant', () => {
    repo.write('a.ts', 'a\n');
    repo.commit('init');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const out = formatReport(r, { strict: false, verbose: false });
    expect(out).not.toContain('notice:');
  });

  it('does NOT show the notice in verbose mode (individual entries are visible)', () => {
    repo.write('r.ts', 'r\n');
    repo.commit('init');
    writeFileSync(`${repo.root}/.cascade/ownership_overrides`, 'r.ts  main\n');
    const r = runCheck({ repoRoot: repo.root, writeMap: false });
    const out = formatReport(r, { strict: false, verbose: true });
    expect(out).not.toContain('notice:');
    // But the individual info entry should be there.
    expect(out).toContain('override-redundant');
  });
});

describe('runCheck — ownership map is written when writeMap=true', () => {
  it('produces /.ownership_map.txt', () => {
    repo.write('x.ts', 'x\n');
    repo.commit('init');
    runCheck({ repoRoot: repo.root, writeMap: true });
    const map = readFileSync(path.join(repo.root, '.ownership_map.txt'), 'utf8');
    expect(map).toContain('x.ts');
  });
});
