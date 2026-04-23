import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { RoleConflictError, loadConfig } from '../scripts/version.js';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';

function setConfig(root: string, yaml: string) {
  writeFileSync(path.join(root, '.cascade', 'config.yaml'), yaml);
}

describe('loadConfig (Phase 2 keys)', () => {
  it('defaults hotfix_loop_warn_days to 14', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    const cfg = loadConfig(r.root);
    expect(cfg.hotfix_loop_warn_days).toBe(14);
    expect(cfg.downstream).toBeNull();
  });

  it('accepts hotfix_loop_warn_days override', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\nhotfix_loop_warn_days: 7\n',
    );
    expect(loadConfig(r.root).hotfix_loop_warn_days).toBe(7);
  });

  it('rejects non-positive hotfix_loop_warn_days', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\nhotfix_loop_warn_days: 0\n',
    );
    expect(() => loadConfig(r.root)).toThrow(/positive integer/);
  });

  it('rejects unknown top-level keys', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\nfoo_bar: 1\n',
    );
    expect(() => loadConfig(r.root)).toThrow(/unknown key/);
  });

  it('rejects unknown keys under downstream', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\ndownstream:\n  source_remote: source\n  extra: x\n',
    );
    expect(() => loadConfig(r.root)).toThrow(/unknown key under downstream/);
  });

  it('rejects invalid source_remote name', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\ndownstream:\n  source_remote: "source,other"\n',
    );
    expect(() => loadConfig(r.root)).toThrow(/not a valid git remote name/);
  });

  it('accepts downstream.source_remote on a downstream-style repo', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\ndownstream:\n  source_remote: source\n',
    );
    r.write('r', 'r\n');
    r.commit('init');
    // Only main exists — no channel/skill/module/edition. Should load.
    const cfg = loadConfig(r.root);
    expect(cfg.downstream).toEqual({ source_remote: 'source' });
  });

  it('raises role-conflict when downstream + channel/ branch present', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    r.write('r', 'r\n');
    r.commit('init');
    r.run('checkout', '-b', 'channel/telegram');
    r.run('checkout', 'main');
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\ndownstream:\n  source_remote: source\n',
    );
    expect(() => loadConfig(r.root)).toThrow(RoleConflictError);
  });

  it('does not raise role-conflict when skipRoleCheck: true', () => {
    const r = makeRepo();
    seedCascadeRegistry(r.root);
    r.write('r', 'r\n');
    r.commit('init');
    r.run('checkout', '-b', 'channel/telegram');
    r.run('checkout', 'main');
    setConfig(
      r.root,
      'version_depth: 3\nupstream_remote: upstream\nupstream_main_branch: main\ndownstream:\n  source_remote: source\n',
    );
    expect(() => loadConfig(r.root, { skipRoleCheck: true })).not.toThrow();
  });
});
