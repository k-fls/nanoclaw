// Helpers to build small fixture git repos for integration tests.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface Repo {
  root: string;
  run: (...args: string[]) => string;
  write: (rel: string, content: string) => void;
  commit: (msg: string) => string;
  branch: (name: string, startPoint?: string) => void;
  checkout: (name: string) => void;
  merge: (source: string, msg?: string) => void;
}

export function makeRepo(prefix = 'cascade-fixture-'): Repo {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  return {
    root,
    run,
    write: (rel, content) => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commit: (msg) => {
      run('add', '.');
      run('commit', '-q', '-m', msg);
      return run('rev-parse', 'HEAD');
    },
    branch: (name, startPoint) => {
      if (startPoint) run('branch', name, startPoint);
      else run('branch', name);
    },
    checkout: (name) => {
      run('checkout', '-q', name);
    },
    merge: (source, msg) => {
      run('merge', '--no-ff', '-m', msg ?? `merge ${source}`, source);
    },
  };
}

// Drop a minimal .cascade/ tree in the repo root so cascade scripts can read
// the registry.
export function seedCascadeRegistry(root: string) {
  const dir = path.join(root, '.cascade');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'branch-classes.yaml'),
    `classes:
  - name: upstream
    pattern: '^upstream/.+$'
    read_only: true
  - name: core
    pattern: '^(core|main)$'
    base: upstream/main
    version_source: upstream/main
  - name: module
    pattern: '^module/[^/]+$'
    base: core
    version_source: core
  - name: channel
    pattern: '^channel/[^/]+$'
    base: core
    version_source: core
  - name: skill
    pattern: '^skill/[^/]+$'
    base: core
    version_source: core
  - name: skill-adapter
    pattern: '^skill/([^/]+)/[^/]+$'
    base_from_match: 'skill/$1'
    version_source_from_match: 'skill/$1'
  - name: edition
    pattern: '^edition/[^/]+$'
    base: core
    version_source: declared
  - name: ephemeral
    pattern: '.*'
    fallback: true
    not_versioned: true
`,
  );
  writeFileSync(
    path.join(dir, 'config.yaml'),
    `version_depth: 3
upstream_remote: upstream
upstream_main_branch: main
`,
  );
  writeFileSync(path.join(dir, 'ownership_rules'), `?node_modules/\npackage-lock.json\n`);
  writeFileSync(path.join(dir, 'bypass-log'), '');
}
