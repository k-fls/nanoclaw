// Schema-enforced component inspection via @anthropic-ai/claude-agent-sdk
// `query()`. Mirrors triage.ts: runs cascade-inspect-discarded and
// cascade-inspect-introduced as one-shot subagents with an in-process MCP
// server exposing `emit_verdict`, whose input is zod-validated.
//
// Inputs are assembled MECHANICALLY from the analyzer report + git, not by
// an orchestrating agent. This removes the "biased dispatch prompt" failure
// mode where the caller's free-form preamble primes the inspector. The user
// prompt contains only the assembled JSON input; the system prompt is the
// agent's .md body.
//
// Parallelism is bounded by --concurrency (default 4, env override
// CASCADE_INSPECT_CONCURRENCY) so we don't fan out unboundedly against API
// rate limits on large components lists.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  query,
  createSdkMcpServer,
  tool,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { loadAgentPrompt } from './triage.js';
import type {
  IntakeReport,
  DiscardedGroup,
  IntroducedGroup,
  InspectionComponent,
} from './intake-analyze.js';

// ---------------- types ----------------

export type InspectionKind = 'discarded' | 'introduced';

export interface CommitContext {
  sha: string;
  subject: string;
  body: string;
  author: string;
  authorDate: string;
}

export interface FocusFileContext {
  path: string;
  base_content: string;
  upstream_tip_content: string;
  upstream_touching_commits: { sha: string; subject: string }[];
  port_hints?: string;
}

export interface ContextFileContext {
  path: string;
  upstream_tip_content_excerpt: string;
}

export interface DiscardedKindContext {
  target_removal_commit: {
    sha: string;
    subject: string;
    body: string;
    author_date: string;
  };
}

export interface IntroducedKindContext {
  target_feature_overview?: string;
}

export interface InspectorInput {
  component_id: string;
  inspection_kind: InspectionKind;
  commits: CommitContext[];
  focus_files: FocusFileContext[];
  context_files: ContextFileContext[];
  kind_specific_context: DiscardedKindContext | IntroducedKindContext;
}

// ---------------- verdict schema ----------------

const CommitVerdictSchema = z
  .object({
    sha: z.string().min(1),
    verdict: z.enum(['adopt', 'remove', 'mixed', 'escalate']),
    escalation_reason: z.string().optional().default(''),
  })
  .strict();

const FeatureNarrativeSchema = z
  .object({
    title: z.string().min(1),
    commits: z.array(z.string().min(1)).min(1),
    description: z.string().min(1),
  })
  .strict();

const VerdictSchema = z
  .object({
    component_id: z.string().min(1),
    inspection_kind: z.enum(['discarded', 'introduced']),
    group_header: z.enum(['all-adopt', 'all-remove', 'mixed', 'inconclusive']),
    commit_verdicts: z.array(CommitVerdictSchema).min(1),
    feature_narratives: z.array(FeatureNarrativeSchema).min(1),
  })
  .strict();

export type Verdict = z.infer<typeof VerdictSchema>;

// ---------------- git helpers (scoped to this file) ----------------

function gitStr(args: string[], repoRoot: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
}

function gitStrOrEmpty(args: string[], repoRoot: string): string {
  try {
    // Silence stderr: the caller's contract is "empty string on failure"
    // (typical case: path didn't exist at that ref — normal for introduced
    // files at base), so git's 'fatal: path ...' noise is not useful.
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return '';
  }
}

function loadCommit(sha: string, repoRoot: string): CommitContext {
  const raw = gitStr(
    ['show', '-s', '--format=%H%n%s%n%an%n%aI%n%b', sha],
    repoRoot,
  );
  const [hash, subject, author, authorDate, ...bodyLines] = raw.split('\n');
  return {
    sha: hash ?? sha,
    subject: subject ?? '',
    author: author ?? '',
    authorDate: authorDate ?? '',
    body: bodyLines.join('\n').trimEnd(),
  };
}

function loadSubject(sha: string, repoRoot: string): string {
  try {
    return gitStr(['show', '-s', '--format=%s', sha], repoRoot).trim();
  } catch {
    return '';
  }
}

// Truncate a file's content to the first N lines for context_files — the
// inspector doesn't need full content for non-focus files, just enough shape
// to see how the component's commits relate.
function truncateLines(content: string, n: number): string {
  if (!content) return '';
  const lines = content.split('\n');
  if (lines.length <= n) return content;
  return lines.slice(0, n).join('\n') + `\n...[truncated; ${lines.length} total lines]`;
}

// port_hints: for files that expose named exports in TS/JS, run `rg` for
// each exported symbol against the target tree. Cheap signal for "does
// target have something that covers this?" The inspector uses this to name
// overlap; if nothing matches, the hint is absent (not a false negative
// claim — the inspector is told in the spec not to fabricate).
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

function computePortHints(
  focusPath: string,
  upstreamContent: string,
  repoRoot: string,
): string | undefined {
  const ext = path.extname(focusPath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return undefined;
  if (!upstreamContent) return undefined;

  const symbols = new Set<string>();
  for (const m of upstreamContent.matchAll(EXPORT_RE)) {
    if (m[1]) symbols.add(m[1]);
  }
  if (symbols.size === 0) return undefined;

  const lines: string[] = [];
  for (const sym of symbols) {
    // rg --fixed-strings avoids regex surprises on names with $. Cap at ~20
    // matches per symbol so a prolific hit doesn't dominate the prompt.
    try {
      const out = execFileSync(
        'rg',
        ['-n', '--fixed-strings', '--max-count', '20', sym, 'src/'],
        { cwd: repoRoot, encoding: 'utf8' },
      ).toString();
      if (out.trim()) {
        lines.push(`# ${sym}\n${out.trimEnd()}`);
      }
    } catch {
      // rg exits 1 when no matches; that's not an error.
    }
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

// ---------------- input assembly ----------------

export interface AssembleOptions {
  repoRoot: string;
  base: string;
  source: string;
  contextFileLineLimit?: number; // default 100
  computePortHintsFn?: typeof computePortHints; // override for tests
}

export function assembleDiscardedInput(
  group: DiscardedGroup,
  opts: AssembleOptions,
): InspectorInput {
  const { repoRoot, base, source } = opts;
  const { component, discardedFiles } = group;
  const lineLimit = opts.contextFileLineLimit ?? 100;
  const portHintsFn = opts.computePortHintsFn ?? computePortHints;

  const focusPaths = new Set(discardedFiles.map((f) => f.path));
  const focus_files: FocusFileContext[] = discardedFiles.map((f) => {
    const baseContent = gitStrOrEmpty(['show', `${base}:${f.path}`], repoRoot);
    const upstreamContent = gitStrOrEmpty(['show', `${source}:${f.path}`], repoRoot);
    const touching: { sha: string; subject: string }[] = f.upstreamTouchingCommits
      .slice()
      .sort()
      .map((sha) => ({ sha, subject: loadSubject(sha, repoRoot) }));
    const port_hints = portHintsFn(f.path, upstreamContent, repoRoot);
    return {
      path: f.path,
      base_content: baseContent,
      upstream_tip_content: upstreamContent,
      upstream_touching_commits: touching,
      ...(port_hints ? { port_hints } : {}),
    };
  });

  const context_files: ContextFileContext[] = component.allTouchedFiles
    .filter((p) => !focusPaths.has(p))
    .map((p) => ({
      path: p,
      upstream_tip_content_excerpt: truncateLines(
        gitStrOrEmpty(['show', `${source}:${p}`], repoRoot),
        lineLimit,
      ),
    }));

  // Pick the removal context anchoring the most files (first, since files
  // can share a removalSha; see SKILL.md's note on loose per-group removal).
  const dominantRemoval = discardedFiles[0];
  let removalCtx: DiscardedKindContext['target_removal_commit'] = {
    sha: '',
    subject: '',
    body: '',
    author_date: '',
  };
  if (dominantRemoval && dominantRemoval.removalSha !== 'unknown') {
    try {
      const raw = gitStr(
        ['show', '-s', '--format=%H%n%s%n%aI%n%b', dominantRemoval.removalSha],
        repoRoot,
      );
      const [sha, subject, authorDate, ...bodyLines] = raw.split('\n');
      removalCtx = {
        sha: sha ?? dominantRemoval.removalSha,
        subject: subject ?? '',
        author_date: authorDate ?? '',
        body: bodyLines.join('\n').trimEnd(),
      };
    } catch {
      // removalSha unreachable — leave blank.
    }
  }

  return {
    component_id: component.id,
    inspection_kind: 'discarded',
    commits: component.commits.map((sha) => loadCommit(sha, repoRoot)),
    focus_files,
    context_files,
    kind_specific_context: { target_removal_commit: removalCtx },
  };
}

export function assembleIntroducedInput(
  group: IntroducedGroup,
  opts: AssembleOptions,
): InspectorInput {
  const { repoRoot, base, source } = opts;
  const { component, introducedFiles } = group;
  const lineLimit = opts.contextFileLineLimit ?? 100;
  const portHintsFn = opts.computePortHintsFn ?? computePortHints;

  const focusPaths = new Set(introducedFiles.map((f) => f.path));
  const focus_files: FocusFileContext[] = introducedFiles.map((f) => {
    // For introduced files, base_content is always "" (path didn't exist at
    // base). We still call git show for defensive correctness — if the path
    // did exist at base for some reason, honor that.
    const baseContent = gitStrOrEmpty(['show', `${base}:${f.path}`], repoRoot);
    const upstreamContent = gitStrOrEmpty(['show', `${source}:${f.path}`], repoRoot);
    const touching: { sha: string; subject: string }[] = f.upstreamTouchingCommits
      .slice()
      .sort()
      .map((sha) => ({ sha, subject: loadSubject(sha, repoRoot) }));
    const port_hints = portHintsFn(f.path, upstreamContent, repoRoot);
    return {
      path: f.path,
      base_content: baseContent,
      upstream_tip_content: upstreamContent,
      upstream_touching_commits: touching,
      ...(port_hints ? { port_hints } : {}),
    };
  });

  const context_files: ContextFileContext[] = component.allTouchedFiles
    .filter((p) => !focusPaths.has(p))
    .map((p) => ({
      path: p,
      upstream_tip_content_excerpt: truncateLines(
        gitStrOrEmpty(['show', `${source}:${p}`], repoRoot),
        lineLimit,
      ),
    }));

  return {
    component_id: component.id,
    inspection_kind: 'introduced',
    commits: component.commits.map((sha) => loadCommit(sha, repoRoot)),
    focus_files,
    context_files,
    // target_feature_overview is a deferred enhancement (inspection.md §
    // Extension points). Omit the key entirely for now — the inspector's
    // spec handles its absence.
    kind_specific_context: {},
  };
}

// ---------------- subagent dispatch ----------------

function resolveModel(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const v = input.trim().toLowerCase();
  if (v === 'opus') return 'claude-opus-4-7';
  if (v === 'sonnet') return 'claude-sonnet-4-6';
  if (v === 'haiku') return 'claude-haiku-4-5';
  return input.trim();
}

function buildInspectorPrompt(input: InspectorInput): string {
  return [
    'Inspect this component per your spec. The input JSON below is the only',
    'input — do not look elsewhere for framing. Emit the verdict by calling',
    'the `emit_verdict` tool with the full verdict object; do not reply in',
    'prose. Follow your spec exactly: `adopt` requires affirmative value,',
    '`remove` requires an affirmative trigger, `mixed` is a real per-commit',
    'split, and `escalate` is the one and only "I need more information or a',
    'reviewer judgment" signal.',
    '',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
  ].join('\n');
}

async function dispatchInspector(opts: {
  input: InspectorInput;
  systemPrompt: string;
  model: string | undefined;
}): Promise<Verdict> {
  let captured: Verdict | null = null;

  const emitVerdict = tool(
    'emit_verdict',
    'Emit the per-commit inspection verdict for this component. Provide component_id, inspection_kind, group_header, commit_verdicts (one per commit in component.commits), and feature_narratives.',
    VerdictSchema.shape,
    async (input) => {
      const parsed = VerdictSchema.safeParse(input);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text:
                'emit_verdict: input failed schema validation: ' +
                JSON.stringify(parsed.error.issues),
            },
          ],
          isError: true,
        };
      }
      captured = parsed.data;
      return { content: [{ type: 'text', text: 'ok — verdict captured' }] };
    },
  );

  const mcpServer = createSdkMcpServer({
    name: 'cascade-inspect',
    version: '0.0.0',
    tools: [emitVerdict],
  });

  const stream = query({
    prompt: buildInspectorPrompt(opts.input),
    options: {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      mcpServers: { cascade: mcpServer },
      allowedTools: ['mcp__cascade__emit_verdict', 'Read', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
    },
  });

  for await (const _msg of stream as AsyncIterable<SDKMessage>) {
    // side effect: captured set when emit_verdict fires
  }

  if (!captured) {
    throw new Error(
      `inspect: agent finished without calling emit_verdict (component ${opts.input.component_id}, kind ${opts.input.inspection_kind})`,
    );
  }
  return captured;
}

// ---------------- concurrency pool ----------------

export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runOne = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runOne());
  await Promise.all(workers);
  return results;
}

// ---------------- top-level entry ----------------

export interface ProgressEvent {
  // Incrementing index of this job in the combined queue (1-based for display).
  index: number;
  total: number;
  kind: InspectionKind;
  component_id: string;
  commit_count: number;
  focus_file_count: number;
  // Present only on 'end' events.
  durationMs?: number;
  verdict?: Verdict;
  error?: Error;
}

export type ProgressHandler = (
  phase: 'start' | 'end' | 'error',
  event: ProgressEvent,
) => void;

export interface InspectOptions {
  analyzerJson: string;
  repoRoot: string;
  discardedAgentPromptPath: string;
  introducedAgentPromptPath: string;
  concurrency?: number;
  model?: string;
  // Reports job start/end to stderr (or a custom handler). Default: stderr
  // printer. Pass `false` to silence.
  progress?: ProgressHandler | false;
  // Optional hook for tests — bypass the SDK call and return a canned verdict.
  dispatch?: (opts: {
    input: InspectorInput;
    systemPrompt: string;
    model: string | undefined;
  }) => Promise<Verdict>;
}

export interface InspectResult {
  discarded: Verdict[];
  introduced: Verdict[];
}

export async function runInspect(opts: InspectOptions): Promise<InspectResult> {
  const analyzer = parseAnalyzer(opts.analyzerJson);

  if (!existsSync(opts.discardedAgentPromptPath)) {
    throw new Error(
      `inspect: discarded agent prompt not found at ${opts.discardedAgentPromptPath}`,
    );
  }
  if (!existsSync(opts.introducedAgentPromptPath)) {
    throw new Error(
      `inspect: introduced agent prompt not found at ${opts.introducedAgentPromptPath}`,
    );
  }
  const { model: discFmModel, body: discSystemPrompt } = loadAgentPrompt(
    opts.discardedAgentPromptPath,
  );
  const { model: introFmModel, body: introSystemPrompt } = loadAgentPrompt(
    opts.introducedAgentPromptPath,
  );

  const concurrency = opts.concurrency ?? defaultConcurrency();
  const dispatch = opts.dispatch ?? dispatchInspector;
  const progress: ProgressHandler | null =
    opts.progress === false ? null : (opts.progress ?? defaultProgressPrinter());

  const assembleOpts: AssembleOptions = {
    repoRoot: opts.repoRoot,
    base: analyzer.base,
    source: analyzer.source,
  };

  type Job =
    | { kind: 'discarded'; input: InspectorInput; systemPrompt: string; model: string | undefined }
    | { kind: 'introduced'; input: InspectorInput; systemPrompt: string; model: string | undefined };

  const discModel = opts.model ? resolveModel(opts.model) : resolveModel(discFmModel);
  const introModel = opts.model ? resolveModel(opts.model) : resolveModel(introFmModel);

  const jobs: Job[] = [
    ...analyzer.discardedGroups.map((g) => ({
      kind: 'discarded' as const,
      input: assembleDiscardedInput(g, assembleOpts),
      systemPrompt: discSystemPrompt,
      model: discModel,
    })),
    ...analyzer.introducedGroups.map((g) => ({
      kind: 'introduced' as const,
      input: assembleIntroducedInput(g, assembleOpts),
      systemPrompt: introSystemPrompt,
      model: introModel,
    })),
  ];

  const total = jobs.length;
  if (progress && total > 0) {
    process.stderr.write(
      `inspect: dispatching ${total} component(s) ` +
        `(${analyzer.discardedGroups.length} discarded, ${analyzer.introducedGroups.length} introduced) ` +
        `with concurrency=${concurrency}\n`,
    );
  }

  const verdicts = await runPool(jobs, concurrency, async (job, idx) => {
    const base: ProgressEvent = {
      index: idx + 1,
      total,
      kind: job.kind,
      component_id: job.input.component_id,
      commit_count: job.input.commits.length,
      focus_file_count: job.input.focus_files.length,
    };
    progress?.('start', base);
    const startedAt = Date.now();
    try {
      const v = await dispatch({
        input: job.input,
        systemPrompt: job.systemPrompt,
        model: job.model,
      });
      progress?.('end', { ...base, durationMs: Date.now() - startedAt, verdict: v });
      return v;
    } catch (e) {
      progress?.('error', {
        ...base,
        durationMs: Date.now() - startedAt,
        error: e as Error,
      });
      throw e;
    }
  });

  const discarded: Verdict[] = [];
  const introduced: Verdict[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const v = verdicts[i]!;
    if (jobs[i]!.kind === 'discarded') discarded.push(v);
    else introduced.push(v);
  }
  return { discarded, introduced };
}

function parseAnalyzer(json: string): IntakeReport {
  try {
    return JSON.parse(json) as IntakeReport;
  } catch (e) {
    throw new Error(`inspect: could not parse analyzer JSON: ${(e as Error).message}`);
  }
}

function defaultProgressPrinter(): ProgressHandler {
  return (phase, e) => {
    const id = e.component_id.slice(0, 10);
    const pos = `[${e.index}/${e.total}]`;
    if (phase === 'start') {
      process.stderr.write(
        `inspect: ${pos} ▶ ${e.kind} ${id} (${e.commit_count} commits, ${e.focus_file_count} focus file(s))\n`,
      );
    } else if (phase === 'end') {
      const v = e.verdict!;
      const counts = countVerdicts(v);
      const secs = ((e.durationMs ?? 0) / 1000).toFixed(1);
      process.stderr.write(
        `inspect: ${pos} ✓ ${e.kind} ${id} → ${v.group_header} ` +
          `(${counts}) in ${secs}s\n`,
      );
    } else {
      const secs = ((e.durationMs ?? 0) / 1000).toFixed(1);
      process.stderr.write(
        `inspect: ${pos} ✗ ${e.kind} ${id} FAILED in ${secs}s — ${e.error?.message ?? 'unknown error'}\n`,
      );
    }
  };
}

function countVerdicts(v: Verdict): string {
  const tally = { adopt: 0, remove: 0, mixed: 0, escalate: 0 };
  for (const cv of v.commit_verdicts) tally[cv.verdict]++;
  return `${tally.adopt}a/${tally.remove}r/${tally.mixed}m/${tally.escalate}e`;
}

function defaultConcurrency(): number {
  const env = process.env.CASCADE_INSPECT_CONCURRENCY;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 4;
}

// ---------------- CLI plumbing ----------------

export interface InspectCliArgs {
  analyzerPath: string;
  discardedOutPath?: string;
  introducedOutPath?: string;
  concurrency?: number;
  model?: string;
  repoRoot: string;
}

export async function runInspectCli(args: InspectCliArgs): Promise<InspectResult> {
  const analyzerJson = readFileSync(args.analyzerPath, 'utf8');
  return runInspect({
    analyzerJson,
    repoRoot: args.repoRoot,
    discardedAgentPromptPath: defaultDiscardedPromptPath(),
    introducedAgentPromptPath: defaultIntroducedPromptPath(),
    concurrency: args.concurrency,
    model: args.model,
  });
}

function defaultDiscardedPromptPath(): string {
  const here = new URL('.', import.meta.url).pathname;
  return path.resolve(here, '../../.claude/agents/cascade-inspect-discarded.md');
}

function defaultIntroducedPromptPath(): string {
  const here = new URL('.', import.meta.url).pathname;
  return path.resolve(here, '../../.claude/agents/cascade-inspect-introduced.md');
}

