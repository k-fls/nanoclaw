// Single `cascade` CLI dispatcher. Phase 0 subcommands:
//   cascade check [--strict] [--json] [--write-map] [--self-test]
//   cascade ownership [--verify] [--json]
//   cascade version <branch> [--json]
//   cascade bypass <commit> <rule> <reason...>
//   cascade merge <source> [--squash] [-m <msg>]
//   cascade self-test
//
// Exit codes follow cascade/docs/phase-0.md § Implementation notes.

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exitCodeFor, formatReport, runCheck, runSelfTest } from './check.js';
import {
  deriveOwnership,
  formatOwnershipMap,
  writeOwnershipMap,
} from './ownership.js';
import { computeVersion, formatVersion } from './version.js';
import { appendBypass } from './bypass.js';
import { mergePreserve } from './merge-preserve.js';

function repoRoot(): string {
  const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  if (!out) throw new Error('cascade: not inside a git repository');
  return out;
}

function die(msg: string, code = 2): never {
  process.stderr.write(`cascade: ${msg}\n`);
  process.exit(code);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? null;
}

function removeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function cmdCheck(args: string[]): number {
  const strict = removeFlag(args, '--strict');
  const json = removeFlag(args, '--json');
  const writeMap = !removeFlag(args, '--no-write-map');
  const selfTest = removeFlag(args, '--self-test');
  const verbose = removeFlag(args, '--verbose') || removeFlag(args, '-v');
  const root = repoRoot();
  const res = runCheck({ repoRoot: root, writeMap, strict, json });
  let selfTestFailed = 0;
  if (selfTest) {
    const st = runSelfTest();
    if (st.failed.length > 0) {
      selfTestFailed = st.failed.length;
      res.violations.push(
        ...st.failed.map((f) => ({
          rule: 'self-test' as const,
          severity: 'error' as const,
          message: `${f.name}: ${f.reason}`,
        })),
      );
      res.errors += st.failed.length;
    }
    if (!json) {
      process.stdout.write(
        `self-test: ${st.passed} passed, ${st.failed.length} failed\n`,
      );
    }
  }
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ...res, selfTestFailed, exitCode: exitCodeFor(res, strict) },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(formatReport(res, { strict, verbose }) + '\n');
  }
  return exitCodeFor(res, strict);
}

function cmdOwnership(args: string[]): number {
  const verify = removeFlag(args, '--verify');
  const json = removeFlag(args, '--json');
  const root = repoRoot();
  const result = deriveOwnership({ repoRoot: root });
  const text = formatOwnershipMap(result);
  void result.hygieneViolations; // silence unused; present in json output
  if (verify) {
    const file = path.join(root, '.ownership_map.txt');
    let existing = '';
    try {
      existing = readFileSync(file, 'utf8');
    } catch {
      process.stderr.write(`cascade: ${file} missing; run \`cascade ownership\` first\n`);
      return 1;
    }
    if (existing !== text) {
      process.stderr.write(
        'cascade: ownership map differs from the regenerated output; run `cascade ownership` to update\n',
      );
      return 1;
    }
    if (!json) process.stdout.write('ownership: verified\n');
    return 0;
  }
  writeOwnershipMap(root, result);
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(
      `ownership: ${result.entries.length} files written; dead_rules=${result.deadRules.length}, double_intros=${result.doubleIntroductions.length}, unowned=${result.unowned.length}\n`,
    );
  }
  return 0;
}

function cmdVersion(args: string[]): number {
  const json = removeFlag(args, '--json');
  const branch = args[0];
  if (!branch) die('usage: cascade version <branch> [--json]');
  const root = repoRoot();
  const report = computeVersion(branch, root);
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  if (report.version) {
    process.stdout.write(
      `${branch}\t${formatVersion(report.version)}\t(source=${report.prefixSource})\n`,
    );
  } else {
    process.stdout.write(`${branch}\tnull\t(${report.notes.join('; ')})\n`);
  }
  return 0;
}

function cmdBypass(args: string[]): number {
  const [commit, rule, ...reasonParts] = args;
  if (!commit || !rule || reasonParts.length === 0) {
    die('usage: cascade bypass <commit> <rule> <reason...>');
  }
  const root = repoRoot();
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const entry = appendBypass(
    { commit, rule, reason: reasonParts.join(' '), branch },
    root,
  );
  process.stdout.write(
    `bypass: logged ${entry.commit} (${entry.rule}) on ${entry.branch}\n`,
  );
  return 0;
}

function cmdMerge(args: string[]): number {
  const squash = removeFlag(args, '--squash');
  const message = takeOption(args, '-m') ?? takeOption(args, '--message') ?? undefined;
  const source = args[0];
  if (!source) die('usage: cascade merge <source> [--squash] [-m <msg>]');
  const root = repoRoot();
  const res = mergePreserve(source, { squash, message }, root);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.code;
}

function cmdSelfTest(): number {
  const st = runSelfTest();
  process.stdout.write(`self-test: ${st.passed} passed, ${st.failed.length} failed\n`);
  for (const f of st.failed) process.stdout.write(`  FAIL ${f.name}: ${f.reason}\n`);
  return st.failed.length === 0 ? 0 : 1;
}

function usage(): string {
  return [
    'cascade — automerge tool for fls-claw (Phase 0)',
    '',
    'commands:',
    '  check [--strict] [--json] [--verbose] [--self-test] [--no-write-map]',
    '  ownership [--verify] [--json]',
    '  version <branch> [--json]',
    '  bypass <commit> <rule> <reason...>',
    '  merge <source> [--squash] [-m <msg>]',
    '  self-test',
    '  help',
  ].join('\n');
}

function main(): number {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'check':
        return cmdCheck(rest);
      case 'ownership':
        return cmdOwnership(rest);
      case 'version':
        return cmdVersion(rest);
      case 'bypass':
        return cmdBypass(rest);
      case 'merge':
        return cmdMerge(rest);
      case 'self-test':
        return cmdSelfTest();
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        process.stdout.write(usage() + '\n');
        return 0;
      default:
        die(`unknown command: ${cmd}\n\n${usage()}`);
    }
  } catch (e) {
    die((e as Error).message, 1);
  }
}

process.exit(main());
