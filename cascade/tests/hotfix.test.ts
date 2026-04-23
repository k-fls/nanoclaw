import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';
import {
  cherryPick,
  continueFlow,
  findOpenHotfixLoops,
  start,
  PAIR_TRAILER,
} from '../scripts/hotfix.js';
import { writeTag } from '../scripts/tags.js';
import { runCheck } from '../scripts/check.js';

const V = (a: number, b: number, c: number, d: number) => ({ a, b, c, d });

function seedWithDeploy(root: string, opts: { warnDays?: number } = {}) {
  seedCascadeRegistry(root);
  writeFileSync(
    path.join(root, '.cascade', 'branch-classes.yaml'),
    `classes:
  - name: upstream
    pattern: '^upstream/.+$'
    read_only: true
  - name: core
    pattern: '^(core|main)$'
    base: upstream/main
    version_source: upstream/main
  - name: channel
    pattern: '^channel/[^/]+$'
    base: core
    version_source: core
  - name: edition
    pattern: '^edition/[^/]+$'
    base: core
    version_source: declared
  - name: deploy
    pattern: '^deploy/[^/]+$'
    base: 'edition/*'
    version_source_from_ancestry: 'edition/*'
  - name: ephemeral
    pattern: '.*'
    fallback: true
    not_versioned: true
`,
  );
  writeFileSync(
    path.join(root, '.cascade', 'config.yaml'),
    `version_depth: 3
upstream_remote: upstream
upstream_main_branch: main
hotfix_loop_warn_days: ${opts.warnDays ?? 14}
`,
  );
}

function buildRepo(opts: { warnDays?: number } = {}) {
  const r = makeRepo();
  seedWithDeploy(r.root, opts);
  r.write('README.md', 'r\n');
  r.commit('init');

  r.run('checkout', '-b', 'upstream/main');
  r.write('u.txt', 'u\n');
  r.commit('up');
  r.run('tag', '-a', 'v1.9.0', '-m', 'u190');

  r.run('checkout', '-b', 'core', 'v1.9.0');
  r.write('c.txt', 'c\n');
  r.commit('core-init');
  r.run('checkout', 'core');
  writeTag({ branch: 'core', version: V(1, 9, 0, 1) }, r.root);

  r.run('checkout', '-b', 'edition/starter', 'core');
  r.write('.cascade/parent_branch', 'core\n');
  r.commit('edition init');
  writeTag(
    {
      branch: 'edition/starter',
      version: V(1, 9, 0, 1),
      snapshot: { schema_version: 1, edition: 'starter' },
    },
    r.root,
  );

  r.run('checkout', '-b', 'deploy/prod', 'edition/starter');
  r.write('deploy.txt', 'd\n');
  r.commit('deploy init');
  writeTag({ branch: 'deploy/prod', version: V(1, 9, 0, 1) }, r.root);

  return r;
}

function commitBody(root: string, ref: string): string {
  return execFileSync('git', ['log', '-1', '--format=%B', ref], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('hotfix start', () => {
  it('creates hotfix/<slug> off core with HEAD on new branch', () => {
    const r = buildRepo();
    const res = start('deploy/prod', 'urgent', r.root);
    expect(res.halted).toBeNull();
    expect(res.ephemeralBranch).toBe('hotfix/urgent');
    expect(r.run('rev-parse', '--abbrev-ref', 'HEAD')).toBe('hotfix/urgent');
    // Branched off core → core is an ancestor.
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', 'core', 'HEAD'], {
        cwd: r.root,
      }),
    ).not.toThrow();
  });

  it('rejects existing hotfix branch', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.run('checkout', 'core');
    const res = start('deploy/prod', 'urgent', r.root);
    expect(res.halted?.kind).toBe('bad-state');
  });

  it('rejects non-deploy branch', () => {
    const r = buildRepo();
    const res = start('core', 'urgent', r.root);
    expect(res.halted?.kind).toBe('bad-state');
  });
});

describe('hotfix cherry-pick', () => {
  it('writes forward trailer and auto-tags deploy with D+1', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'the fix\n');
    const ephSha = r.commit('hotfix: the fix');

    const res = cherryPick('deploy/prod', r.root);
    expect(res.halted).toBeNull();
    expect(res.cherryPickBranch).toBe('deploy/prod');
    expect(res.tag?.tag).toBe('deploy/prod/1.9.0.2');

    const body = commitBody(r.root, 'deploy/prod');
    expect(body).toContain(`${PAIR_TRAILER}: ${ephSha}`);
  });

  it('halts on cherry-pick conflict with details.operation=cherry-pick', () => {
    const r = buildRepo();
    // Create a conflicting change on deploy first.
    r.run('checkout', 'deploy/prod');
    r.write('conflict.txt', 'deploy version\n');
    r.commit('deploy: add conflict.txt');

    start('deploy/prod', 'urgent', r.root);
    r.write('conflict.txt', 'hotfix version\n');
    r.commit('hotfix: conflicting edit');

    const res = cherryPick('deploy/prod', r.root);
    expect(res.halted?.kind).toBe('merge-conflict');
    expect((res.halted?.details as Record<string, unknown>)?.operation).toBe('cherry-pick');
    // HEAD is on deploy/prod (mid-cherry-pick state).
    expect(r.run('rev-parse', '--abbrev-ref', 'HEAD')).toBe('deploy/prod');
  });
});

describe('hotfix continue', () => {
  it('merges ephemeral into core and writes reverse trailer (SHA handle)', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'the fix\n');
    const ephSha = r.commit('hotfix: the fix');
    cherryPick('deploy/prod', r.root);

    const cherrySha = r.run('rev-parse', 'deploy/prod');
    const res = continueFlow(ephSha, r.root);
    expect(res.halted).toBeNull();
    expect(res.cherryPickSha).toBe(cherrySha);
    expect(res.cherryPickBranch).toBe('deploy/prod');
    expect(res.mergeSha).toBeDefined();

    const body = commitBody(r.root, 'core');
    expect(body).toContain(`${PAIR_TRAILER}: ${cherrySha}`);
  });

  it('accepts hotfix/<slug> as handle identically', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    r.commit('hotfix: fix');
    cherryPick('deploy/prod', r.root);

    const cherrySha = r.run('rev-parse', 'deploy/prod');
    const res = continueFlow('hotfix/urgent', r.root);
    expect(res.halted).toBeNull();
    expect(res.cherryPickSha).toBe(cherrySha);
  });

  it('re-derives cherry-pick SHA when deploy is amended before continue', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    r.commit('hotfix: fix');
    cherryPick('deploy/prod', r.root);

    // Amend the cherry-pick on deploy (trailer survives the amend).
    r.run('checkout', 'deploy/prod');
    r.write('fix.txt', 'fix v2\n');
    r.run('add', '.');
    r.run('commit', '--amend', '--no-edit');
    const newCherrySha = r.run('rev-parse', 'deploy/prod');

    const res = continueFlow('hotfix/urgent', r.root);
    expect(res.halted).toBeNull();
    expect(res.cherryPickSha).toBe(newCherrySha);
    expect(commitBody(r.root, 'core')).toContain(`${PAIR_TRAILER}: ${newCherrySha}`);
  });

  it('halts with missing-pair when no deploy cherry-pick exists', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    const ephSha = r.commit('hotfix: fix');
    const res = continueFlow(ephSha, r.root);
    expect(res.halted?.kind).toBe('missing-pair');
  });
});

describe('hotfix-loop-open check', () => {
  it('closes after propagate carries the core fix back to deploy', () => {
    const r = buildRepo();
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    r.commit('hotfix: fix');
    cherryPick('deploy/prod', r.root);
    continueFlow('hotfix/urgent', r.root);

    // Simulate propagation: merge core into edition, then edition into deploy.
    r.run('checkout', 'edition/starter');
    r.run('merge', '--no-ff', '-m', 'merge core', 'core');
    r.run('checkout', 'deploy/prod');
    r.run('merge', '--no-ff', '-m', 'merge edition', 'edition/starter');

    const violations = findOpenHotfixLoops(r.root);
    expect(violations).toEqual([]);
  });

  it('does not fire within warn_days window', () => {
    const r = buildRepo({ warnDays: 14 });
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    r.commit('hotfix: fix');
    cherryPick('deploy/prod', r.root);
    // No continueFlow, no propagation. Fresh cherry-pick < 14 days.
    const violations = findOpenHotfixLoops(r.root);
    expect(violations).toEqual([]);
  });

  it('fires after warn_days elapse with no reverse-pair reachable', () => {
    const r = buildRepo({ warnDays: 3 });
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    r.commit('hotfix: fix');
    cherryPick('deploy/prod', r.root);
    // Back-date to between warn_days and warn_days×2 (the grep window).
    const fiveDaysAgo = Math.floor(Date.now() / 1000) - 5 * 86400;
    execFileSync(
      'git',
      ['commit', '--amend', '--no-edit', '--date', `${fiveDaysAgo}`],
      {
        cwd: r.root,
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: `${fiveDaysAgo} +0000`,
        },
      },
    );

    const violations = findOpenHotfixLoops(r.root);
    expect(violations.length).toBe(1);
    expect(violations[0].deploy).toBe('deploy/prod');
  });

  it('is recorded as a warning by runCheck with bypass-log suppressing', () => {
    const r = buildRepo({ warnDays: 3 });
    start('deploy/prod', 'urgent', r.root);
    r.write('fix.txt', 'fix\n');
    r.commit('hotfix: fix');
    cherryPick('deploy/prod', r.root);
    const fiveDaysAgo = Math.floor(Date.now() / 1000) - 5 * 86400;
    execFileSync(
      'git',
      ['commit', '--amend', '--no-edit', '--date', `${fiveDaysAgo}`],
      {
        cwd: r.root,
        env: { ...process.env, GIT_COMMITTER_DATE: `${fiveDaysAgo} +0000` },
      },
    );
    const cherrySha = r.run('rev-parse', 'deploy/prod');

    const before = runCheck({ repoRoot: r.root, writeMap: false });
    expect(before.violations.some((v) => v.rule === 'hotfix-loop-open')).toBe(true);

    // Bypass it.
    writeFileSync(
      path.join(r.root, '.cascade', 'bypass-log'),
      `${cherrySha}  2026-04-01  deploy/prod  hotfix-loop-open  manual ack\n`,
    );
    const after = runCheck({ repoRoot: r.root, writeMap: false });
    expect(after.violations.some((v) => v.rule === 'hotfix-loop-open')).toBe(false);
    expect(after.bypassed.some((v) => v.rule === 'hotfix-loop-open')).toBe(true);
  });
});
