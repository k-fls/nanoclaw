// Schema-enforced triage via @anthropic-ai/claude-agent-sdk `query()`.
// Runs the cascade-triage-intake subagent as a one-shot with an in-process
// MCP server exposing a single tool, `emit_plan`, whose input is zod-
// validated. The agent is steered to call that tool; the tool's input IS
// the plan. Schema enforcement is native to the SDK's MCP integration.
//
// Prompt source of truth: .claude/agents/cascade-triage-intake.md. Read at
// runtime, frontmatter stripped, body used as system prompt — no prompt
// duplication in code.

import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  query,
  createSdkMcpServer,
  tool,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  PlanDraftSchema,
  enrichPlan,
  validatePlan,
  formatValidateReport,
  type Plan,
  type PlanDraft,
  type Violation,
} from './intake-validate.js';
import type { IntakeReport } from './intake-analyze.js';

export interface TriageInputs {
  analyzerJson: string;
  divergenceReport?: string;
  deletionVerdicts?: string;
}

export interface TriageOptions {
  agentPromptPath: string;
  inputs: TriageInputs;
  model?: string;
  // Max retries if the agent's plan fails validation. Default 3; the agent
  // gets 4 total attempts (initial + 3 retries). Each retry passes the
  // previous plan + violations back into the user prompt.
  maxRetries?: number;
}

export interface TriageResult {
  plan: Plan;
  attempts: number;
}

// Parse the markdown frontmatter; return { model, body }.
export function loadAgentPrompt(mdPath: string): { model?: string; body: string } {
  const raw = readFileSync(mdPath, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const frontmatter = m[1];
  const body = m[2];
  const model = frontmatter.match(/^model:\s*(.+?)\s*$/m)?.[1];
  return { model, body: body.trimStart() };
}

// Resolve the `model:` frontmatter value. Aliases → latest stable IDs.
function resolveModel(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const v = input.trim().toLowerCase();
  if (v === 'opus') return 'claude-opus-4-7';
  if (v === 'sonnet') return 'claude-sonnet-4-6';
  if (v === 'haiku') return 'claude-haiku-4-5';
  return input.trim();
}

// Build the user prompt. The system prompt (from the md) carries the
// authoritative grouping rules; the user prompt carries the dynamic inputs
// plus, on retry, the previous plan and the validator's violations.
function buildPrompt(
  inputs: TriageInputs,
  retry?: { previousPlan: Plan; violations: Violation[] },
): string {
  const parts: string[] = [];
  parts.push('## Analyzer JSON\n\n```json\n' + inputs.analyzerJson + '\n```');
  if (inputs.divergenceReport) {
    parts.push('## Divergence report\n\n```\n' + inputs.divergenceReport + '\n```');
  }
  if (inputs.deletionVerdicts) {
    parts.push('## fls-deletion verdicts\n\n```json\n' + inputs.deletionVerdicts + '\n```');
  }
  if (retry) {
    parts.push(
      '## Previous plan (failed validation)\n\n```json\n' +
        JSON.stringify(retry.previousPlan, null, 2) +
        '\n```',
    );
    parts.push(
      '## Validator violations — address each one and re-emit the full plan\n\n```json\n' +
        JSON.stringify(retry.violations, null, 2) +
        '\n```',
    );
  }
  parts.push(
    'Emit the plan by calling the `emit_plan` tool. Do not respond with prose; call the tool directly with the full plan as its argument.',
  );
  return parts.join('\n\n');
}

// One round-trip with the agent: send the prompt, wait for emit_plan to
// fire, return the validated draft.
async function captureDraft(
  opts: TriageOptions,
  systemPrompt: string,
  model: string | undefined,
  prompt: string,
): Promise<PlanDraft> {
  let captured: PlanDraft | null = null;
  const emitPlan = tool(
    'emit_plan',
    'Emit the P1 intake decomposition plan. Provide ONLY subjective fields per group (name, commits[], attention, expected_outcome, mechanical_complexity, tags, functional_summary, grouping_rationale). Derived fields (kind, files, requiresAgentResolution, index) are computed automatically — do not emit them.',
    PlanDraftSchema.shape,
    async (input) => {
      const parsed = PlanDraftSchema.safeParse(input);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text:
                'emit_plan: input failed draft validation: ' +
                JSON.stringify(parsed.error.issues),
            },
          ],
          isError: true,
        };
      }
      captured = parsed.data;
      return {
        content: [{ type: 'text', text: 'ok — plan captured' }],
      };
    },
  );

  const mcpServer = createSdkMcpServer({
    name: 'cascade-triage',
    version: '0.0.0',
    tools: [emitPlan],
  });

  const stream = query({
    prompt,
    options: {
      systemPrompt,
      model,
      mcpServers: { cascade: mcpServer },
      // Tool surface: read-only access to repo contents for inspecting
      // actual code changes + emit_plan as the single mutating action.
      allowedTools: [
        'mcp__cascade__emit_plan',
        'Read',
        'Glob',
        'Grep',
        'Bash',
      ],
      permissionMode: 'bypassPermissions',
    },
  });

  for await (const _msg of stream as AsyncIterable<SDKMessage>) {
    // side effect: `captured` set when emit_plan fires
  }

  if (!captured) {
    throw new Error(
      'triage: agent finished without calling emit_plan — check the prompt or retry',
    );
  }
  return captured;
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  if (!existsSync(opts.agentPromptPath)) {
    throw new Error(`triage: agent prompt not found at ${opts.agentPromptPath}`);
  }
  const { model: fmModel, body: systemPrompt } = loadAgentPrompt(opts.agentPromptPath);
  const model = opts.model ? resolveModel(opts.model) : resolveModel(fmModel);
  const analyzer = parseAnalyzer(opts.inputs.analyzerJson);
  const maxRetries = opts.maxRetries ?? 3;

  let retry: { previousPlan: Plan; violations: Violation[] } | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prompt = buildPrompt(opts.inputs, retry);
    const draft = await captureDraft(opts, systemPrompt, model, prompt);
    const plan = enrichPlan(draft, analyzer);
    const result = validatePlan({ plan, analyzer });
    if (result.errors === 0) {
      return { plan, attempts: attempt + 1 };
    }
    retry = { previousPlan: plan, violations: result.violations };
    // On last iteration, this retry context is built but we won't loop again.
  }

  // Exhausted retries. Surface the final violations verbatim so the caller
  // can decide what to do (the skill escalates to the human).
  const finalReport = formatValidateReport({
    violations: retry!.violations,
    errors: retry!.violations.filter((v) => v.severity === 'error').length,
    warnings: retry!.violations.filter((v) => v.severity === 'warning').length,
  });
  throw new Error(
    `triage: could not produce a valid plan after ${maxRetries + 1} attempts\n\n${finalReport}`,
  );
}

function parseAnalyzer(json: string): IntakeReport {
  try {
    return JSON.parse(json) as IntakeReport;
  } catch (e) {
    throw new Error(`triage: could not parse analyzer JSON: ${(e as Error).message}`);
  }
}

// ---------------- CLI plumbing ----------------

export interface CliArgs {
  analyzerPath: string;
  divergencePath?: string;
  verdictsPath?: string;
  agentPromptPath?: string;
  model?: string;
  maxRetries?: number;
}

export async function runTriageCli(args: CliArgs): Promise<TriageResult> {
  const agentPromptPath = args.agentPromptPath ?? defaultAgentPromptPath();
  const inputs: TriageInputs = {
    analyzerJson: readFileSync(args.analyzerPath, 'utf8'),
    divergenceReport: args.divergencePath
      ? readFileSync(args.divergencePath, 'utf8')
      : undefined,
    deletionVerdicts: args.verdictsPath
      ? readFileSync(args.verdictsPath, 'utf8')
      : undefined,
  };
  return runTriage({
    agentPromptPath,
    inputs,
    model: args.model,
    maxRetries: args.maxRetries,
  });
}

function defaultAgentPromptPath(): string {
  const here = new URL('.', import.meta.url).pathname;
  return path.resolve(here, '../../.claude/agents/cascade-triage-intake.md');
}
