// Schema-enforced triage via Anthropic SDK tool use.
// Replaces in-session Task/Agent invocation of `cascade-triage-intake`.
// The plan shape is enforced at decode time by tool_choice + JSON Schema,
// so the model physically cannot emit anything that doesn't match.
//
// Prompt source of truth: .claude/agents/cascade-triage-intake.md. This
// script reads the markdown at run time, strips frontmatter, and uses the
// body as the system prompt. No prompt duplication.

import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { PlanSchema, type Plan } from './intake-validate.js';

export interface TriageInputs {
  analyzerJson: string;      // stringified analyzer JSON
  divergenceReport?: string; // plain-text divergence-report output
  deletionVerdicts?: string; // stringified JSON array of inspector verdicts
  previousPlan?: string;     // stringified prior plan (for retries)
  validatorViolations?: string; // stringified violations JSON (for retries)
}

export interface TriageOptions {
  agentPromptPath: string;   // path to .claude/agents/cascade-triage-intake.md
  inputs: TriageInputs;
  // Optional model override; defaults to the frontmatter value in the md.
  model?: string;
  // Defensive caps; real runs should fit easily.
  maxTokens?: number;
}

export interface TriageResult {
  plan: Plan;
  rawToolInput: unknown;
  stopReason: string;
  usage?: Anthropic.Usage;
}

// Parse the markdown frontmatter; return { model, body }. Tolerates CRLF
// and missing frontmatter (returns body=full content, model=undefined).
export function loadAgentPrompt(mdPath: string): { model?: string; body: string } {
  const raw = readFileSync(mdPath, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const frontmatter = m[1];
  const body = m[2];
  const model = frontmatter.match(/^model:\s*(.+?)\s*$/m)?.[1];
  return { model, body: body.trimStart() };
}

// Resolve the `model:` frontmatter value. `opus` / `sonnet` / `haiku` map to
// the latest stable IDs; bare IDs pass through unchanged.
function resolveModel(input: string | undefined): string {
  const fallback = 'claude-opus-4-7';
  if (!input) return fallback;
  const v = input.trim().toLowerCase();
  if (v === 'opus') return fallback;
  if (v === 'sonnet') return 'claude-sonnet-4-6';
  if (v === 'haiku') return 'claude-haiku-4-5';
  return input.trim();
}

// Derive the JSON Schema the SDK passes to tool_use. Uses zod v4's native
// `z.toJSONSchema`. Target is the full Plan; model is constrained to this
// shape at decode time.
function planJsonSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(PlanSchema) as Record<string, unknown>;
  // Drop meta fields the Anthropic API doesn't need (and may reject).
  const { $schema: _s, ...rest } = raw;
  return rest;
}

// Build the user-turn message. The agent prompt (system) is static; the
// analyzer + optional retry context is dynamic input.
function buildUserContent(inputs: TriageInputs): string {
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
    'Emit the plan by calling the `emit_plan` tool. Do not respond with text; call the tool directly.',
  );
  return parts.join('\n\n');
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  if (!existsSync(opts.agentPromptPath)) {
    throw new Error(`triage: agent prompt not found at ${opts.agentPromptPath}`);
  }
  const { model: fmModel, body: system } = loadAgentPrompt(opts.agentPromptPath);
  const model = resolveModel(opts.model ?? fmModel);
  const client = new Anthropic(); // picks up ANTHROPIC_API_KEY from env

  const toolSchema = planJsonSchema();
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system,
    tools: [
      {
        name: 'emit_plan',
        description:
          'Emit the P1 intake decomposition plan. The input must satisfy the plan schema exactly.',
        input_schema: toolSchema as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: 'emit_plan' },
    messages: [
      {
        role: 'user',
        content: buildUserContent(opts.inputs),
      },
    ],
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit_plan',
  );
  if (!toolBlock) {
    throw new Error(
      `triage: model did not call emit_plan (stop_reason=${response.stop_reason})`,
    );
  }

  // tool_use.input is already schema-checked by the API decoder, but parse
  // through zod too — belt and suspenders, and yields typed Plan.
  const parsed = PlanSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    throw new Error(
      `triage: emit_plan input failed zod re-check (unexpected): ${parsed.error.message}`,
    );
  }
  return {
    plan: parsed.data,
    rawToolInput: toolBlock.input,
    stopReason: response.stop_reason ?? 'unknown',
    usage: response.usage,
  };
}

// ---------------- CLI plumbing (for `cascade triage ...`) ----------------

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
  const agentPromptPath =
    args.agentPromptPath ?? defaultAgentPromptPath();
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
  const result = await runTriage({
    agentPromptPath,
    inputs,
    model: args.model,
  });
  return result.plan;
}

// Find .claude/agents/cascade-triage-intake.md relative to the repo root.
function defaultAgentPromptPath(): string {
  // cascade/scripts/ is two levels below repo root.
  const here = new URL('.', import.meta.url).pathname;
  return path.resolve(here, '../../.claude/agents/cascade-triage-intake.md');
}
