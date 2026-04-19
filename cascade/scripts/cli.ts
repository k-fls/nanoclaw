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
import { analyzeIntake, formatReport as formatIntakeReport } from './intake-analyze.js';
import { divergenceReport, formatDivergenceReport } from './divergence-report.js';
import { validatePlan, formatValidateReport } from './intake-validate.js';
import { runTriageCli } from './triage.js';
import {
  abortIntakeMerge,
  continueIntakeMerge,
  runIntakeMerge,
} from './intake-upstream.js';

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

function cmdIntakeAnalyze(args: string[]): number {
  const json = removeFlag(args, '--json');
  const target = takeOption(args, '--target') ?? undefined;
  const source = takeOption(args, '--source') ?? undefined;
  const root = repoRoot();
  const report = analyzeIntake({ repoRoot: root, target, source });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatIntakeReport(report) + '\n');
  }
  return 0;
}

function cmdDivergenceReport(args: string[]): number {
  const json = removeFlag(args, '--json');
  const verbose = removeFlag(args, '--verbose') || removeFlag(args, '-v');
  const target = takeOption(args, '--target') ?? undefined;
  const source = takeOption(args, '--source') ?? undefined;
  const root = repoRoot();
  const report = divergenceReport({ repoRoot: root, target, source });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatDivergenceReport(report, { verbose }) + '\n');
  }
  return 0;
}

function cmdIntakeUpstream(args: string[]): number {
  const json = removeFlag(args, '--json');
  const dryRun = removeFlag(args, '--dry-run');
  const abort = removeFlag(args, '--abort');
  const continueFlag = removeFlag(args, '--continue');
  const source = takeOption(args, '--source') ?? 'upstream';
  const message = takeOption(args, '-m') ?? takeOption(args, '--message');
  const upto = args[0];
  const root = repoRoot();

  if (abort) {
    abortIntakeMerge(root);
    if (!json) process.stdout.write('intake-upstream: aborted\n');
    return 0;
  }
  if (continueFlag) {
    const r = continueIntakeMerge(root, message ?? undefined);
    if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else process.stdout.write(formatMergeResult(r));
    return r.status === 'conflicted' ? 1 : 0;
  }
  if (!upto) die('usage: cascade intake-upstream <upto-sha> [--source <name>] [-m <msg>] [--dry-run]');
  if (!message) die('intake-upstream: -m <message> is required');
  const r = runIntakeMerge({
    repoRoot: root,
    upto,
    source,
    message: message!,
    dryRun,
  });
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatMergeResult(r));
  return r.status === 'conflicted' ? 1 : 0;
}

function formatMergeResult(
  r: import('./intake-upstream.js').IntakeMergeResult,
): string {
  const lines: string[] = [];
  lines.push(`intake-upstream: ${r.status} (${r.target} ← ${r.source} @ ${r.upto.slice(0, 7)})`);
  if (r.mergeSha) lines.push(`  merge commit: ${r.mergeSha.slice(0, 12)}`);
  if (r.conflicts.length > 0) {
    lines.push(`  conflicts (${r.conflicts.length}):`);
    for (const c of r.conflicts) lines.push(`    ${c.kind.padEnd(16)} ${c.path}`);
    lines.push('  resolve, git add, then rerun with --continue');
  }
  if (r.stderr) lines.push(r.stderr.trimEnd());
  return lines.join('\n') + '\n';
}

function cmdIntakeValidate(args: string[]): number {
  const json = removeFlag(args, '--json');
  const [analyzerPath, planPath] = args;
  if (!analyzerPath || !planPath) {
    die('usage: cascade intake-validate <analyzer.json> <plan.json> [--json]');
  }
  const res = validatePlan({ analyzerPath, planPath });
  if (json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    process.stdout.write(formatValidateReport(res));
  }
  return res.errors === 0 ? 0 : 1;
}

async function cmdTriage(args: string[]): Promise<number> {
  const analyzerPath = takeOption(args, '--analyzer');
  const divergencePath = takeOption(args, '--divergence') ?? undefined;
  const discardedVerdictsPath = takeOption(args, '--discarded-verdicts') ?? undefined;
  const introducedVerdictsPath = takeOption(args, '--introduced-verdicts') ?? undefined;
  const outPath = takeOption(args, '--out') ?? undefined;
  const model = takeOption(args, '--model') ?? undefined;
  const maxRetriesStr = takeOption(args, '--max-retries');
  const maxRetries = maxRetriesStr ? Number(maxRetriesStr) : undefined;
  if (!analyzerPath) {
    die(
      'usage: cascade triage --analyzer <path> [--divergence <path>] [--discarded-verdicts <path>] [--introduced-verdicts <path>] [--out <path>] [--model <id>] [--max-retries <n>]',
    );
  }
  const { plan, attempts } = await runTriageCli({
    analyzerPath: analyzerPath!,
    divergencePath,
    discardedVerdictsPath,
    introducedVerdictsPath,
    model,
    maxRetries,
  });
  const out = JSON.stringify(plan, null, 2) + '\n';
  if (outPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(outPath, out, 'utf8');
    process.stdout.write(`triage: wrote valid plan to ${outPath} (attempts=${attempts})\n`);
  } else {
    process.stdout.write(out);
  }
  return 0;
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
    '  intake-analyze [--target <ref>] [--source <ref>] [--json]',
    '  divergence-report [--target <ref>] [--source <ref>] [--verbose] [--json]',
    '  intake-upstream <upto-sha> -m <msg> [--source <name>] [--dry-run] [--json]',
    '  intake-upstream --continue [-m <msg>] [--json]',
    '  intake-upstream --abort',
    '  intake-validate <analyzer.json> <plan.json> [--json]',
    '  triage --analyzer <path> [--divergence <p>] [--discarded-verdicts <p>] [--introduced-verdicts <p>] [--out <p>] [--model <id>] [--max-retries <n>]',
    '  self-test',
    '  help',
  ].join('\n');
}

async function main(): Promise<number> {
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
      case 'intake-analyze':
        return cmdIntakeAnalyze(rest);
      case 'divergence-report':
        return cmdDivergenceReport(rest);
      case 'intake-upstream':
        return cmdIntakeUpstream(rest);
      case 'intake-validate':
        return cmdIntakeValidate(rest);
      case 'triage':
        return await cmdTriage(rest);
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
  return 0;
}

main().then((code) => process.exit(code));
