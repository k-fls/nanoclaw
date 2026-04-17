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
import { PlanSchema, type Plan } from './intake-validate.js';

export interface TriageInputs {
  analyzerJson: string;
  divergenceReport?: string;
  deletionVerdicts?: string;
  previousPlan?: string;
  validatorViolations?: string;
}

export interface TriageOptions {
  agentPromptPath: string;
  inputs: TriageInputs;
  model?: string;
}

export interface TriageResult {
  plan: Plan;
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
// authoritative grouping rules; the user prompt carries the dynamic inputs.
function buildPrompt(inputs: TriageInputs): string {
  const parts: string[] = [];
  parts.push('## Analyzer JSON\n\n```json\n' + inputs.analyzerJson + '\n```');
  if (inputs.divergenceReport) {
    parts.push('## Divergence report\n\n```\n' + inputs.divergenceReport + '\n```');
  }
  if (inputs.deletionVerdicts) {
    parts.push('## fls-deletion verdicts\n\n```json\n' + inputs.deletionVerdicts + '\n```');
  }
  if (inputs.previousPlan && inputs.validatorViolations) {
    parts.push(
      '## Previous plan (failed validation)\n\n```json\n' +
        inputs.previousPlan +
        '\n```',
    );
    parts.push(
      '## Validator violations — address each one and re-emit the full plan\n\n```json\n' +
        inputs.validatorViolations +
        '\n```',
    );
  }
  parts.push(
    'Emit the plan by calling the `emit_plan` tool. Do not respond with prose; call the tool directly with the full plan as its argument.',
  );
  return parts.join('\n\n');
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  if (!existsSync(opts.agentPromptPath)) {
    throw new Error(`triage: agent prompt not found at ${opts.agentPromptPath}`);
  }
  const { model: fmModel, body: systemPrompt } = loadAgentPrompt(opts.agentPromptPath);
  const model = opts.model ? resolveModel(opts.model) : resolveModel(fmModel);

  // Schema-enforced handoff. The tool receives a zod-validated Plan; the
  // handler captures it for us. We return a terminal string so the agent
  // knows the turn is done and doesn't keep calling tools.
  let capturedPlan: Plan | null = null;
  const emitPlan = tool(
    'emit_plan',
    'Emit the P1 intake decomposition plan. The input IS the plan; it is validated against the Plan schema.',
    PlanSchema.shape,
    async (input) => {
      // `input` is already zod-parsed by the SDK against PlanSchema.shape.
      // We additionally re-parse the full PlanSchema to capture refinements
      // on nested objects (e.g. groups array items).
      const parsed = PlanSchema.safeParse(input);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text:
                'emit_plan: input failed validation: ' +
                JSON.stringify(parsed.error.issues),
            },
          ],
          isError: true,
        };
      }
      capturedPlan = parsed.data;
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

  const prompt = buildPrompt(opts.inputs);
  const stream = query({
    prompt,
    options: {
      systemPrompt,
      model,
      mcpServers: { cascade: mcpServer },
      // Tool surface: read-only access to repo contents for inspecting
      // actual code changes + emit_plan as the single mutating action.
      // The agent prompt instructs when to inspect (small/medium diffs) and
      // when to skip (huge diffs → raise attention instead of reading).
      // Bash is included for `git show` / `git log` / `git diff`; the
      // prompt forbids mutating git commands.
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

  // Drain the stream. The handler captures the plan when the tool fires.
  for await (const _msg of stream as AsyncIterable<SDKMessage>) {
    // no-op — the side effect is `capturedPlan` being set.
  }

  if (!capturedPlan) {
    throw new Error(
      'triage: agent finished without calling emit_plan — check the prompt or retry',
    );
  }
  return { plan: capturedPlan };
}

// ---------------- CLI plumbing ----------------

export interface CliArgs {
  analyzerPath: string;
  divergencePath?: string;
  verdictsPath?: string;
  previousPlanPath?: string;
  violationsPath?: string;
  agentPromptPath?: string;
  model?: string;
}

export async function runTriageCli(args: CliArgs): Promise<Plan> {
  const agentPromptPath = args.agentPromptPath ?? defaultAgentPromptPath();
  const inputs: TriageInputs = {
    analyzerJson: readFileSync(args.analyzerPath, 'utf8'),
    divergenceReport: args.divergencePath
      ? readFileSync(args.divergencePath, 'utf8')
      : undefined,
    deletionVerdicts: args.verdictsPath
      ? readFileSync(args.verdictsPath, 'utf8')
      : undefined,
    previousPlan: args.previousPlanPath
      ? readFileSync(args.previousPlanPath, 'utf8')
      : undefined,
    validatorViolations: args.violationsPath
      ? readFileSync(args.violationsPath, 'utf8')
      : undefined,
  };
  const result = await runTriage({ agentPromptPath, inputs, model: args.model });
  return result.plan;
}

function defaultAgentPromptPath(): string {
  const here = new URL('.', import.meta.url).pathname;
  return path.resolve(here, '../../.claude/agents/cascade-triage-intake.md');
}
