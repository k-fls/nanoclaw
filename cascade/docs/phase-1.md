# Phase 1 — P1 upstream intake

Scope for the second implementation pass. Handles the ongoing merge of `upstream/main` into `core`: analyze the range, inspect file-level signals the merge's mechanical default would bury, triage the commits into reviewable sub-merges, land each with its own `--no-ff` merge commit, and draft resolutions for predicted conflicts. Depends on Phase 0; runs independently of every later phase.

The three-tier rule drives the shape: scripts do deterministic mechanics (analyze, group, validate, merge), agents draft judgment calls at two pre-agreed seams (component inspection and conflict resolution), and the human approves the decomposition plan before any merge commit lands on `core`.

## Deliverables

### Scripts (`cascade/scripts/`)

- **`intake-analyze.ts`** — read-only analysis of the range `merge-base(target, source)..source`. Per-commit signals (`primaryKind`, files, tags, parents, `whitespaceOnly` per (commit, path), `revertedAt` rollback-window membership), aggregate file set, target-vs-base divergence intersection, conflict prediction via `git merge-tree --write-tree`, break points (commits carrying upstream tags), rename tracking, and the two inspection-group arrays:
  - **`discardedGroups[i]`** — connected components whose focus files the target removed post-base and upstream keeps modifying (upstream delta ≥ `discarded_min_delta_lines`).
  - **`introducedGroups[i]`** — connected components whose focus files upstream added and the target never had (file size ≥ `introduced_min_file_lines` on source tip).
  Components are formed by union-find over the bipartite commit ↔ file graph, seeded by candidate-file-touching commits (see [inspection.md § Component grouping](inspection.md)). Output is structured JSON + a human-readable pretty-print; both are deterministic for a fixed `(target_sha, source_sha, merge_base, range)`. The `cacheKey` field attests to the range — plans and verdicts are bound to it and rejected when stale.

- **`divergence-report.ts`** — `git diff merge-base..target` rendered per-file/per-hunk as JSON + text. Minimal surface required by Phase 1 (the triage agent benefits from seeing where the target has diverged); the full annotated grouped version is deferred to Phase 5.

- **`inspect.ts`** — dispatches the two inspector subagents over `discardedGroups` and `introducedGroups`, in parallel with bounded concurrency (default 4, env `CASCADE_INSPECT_CONCURRENCY`). Inputs are assembled **mechanically** from the analyzer report + git blobs — no orchestrating agent composes the prompt. For each component, builds the unified input envelope from [inspection.md § Unified input envelope](inspection.md): commit headers + bodies, focus-file `base_content` / `upstream_tip_content` (full blobs via `git show`), `upstream_touching_commits` with subjects, `port_hints` from `rg` for each exported TS/JS symbol, context-file excerpts (first 100 lines), and kind-specific context (`target_removal_commit` for discarded; `target_feature_overview` omitted per the deferred-enhancement note). Dispatches via `@anthropic-ai/claude-agent-sdk` `query()` with an in-process MCP server exposing a single `emit_verdict` tool whose input is zod-enforced at decode time. Progress reporter prints `▶` on start and `✓` with `group_header` + `adopt/remove/mixed/escalate` counts on completion.

- **`triage.ts`** — runs the `cascade-triage-intake` subagent via `query()` with an in-process MCP server exposing a single `emit_plan` tool. The tool's input schema is the **draft** plan shape (`PlanDraftSchema` — subjective fields only: `name`, `commits[]`, `attention`, `expected_outcome`, `mechanical_complexity`, `tags`, `functional_summary`, `grouping_rationale`, plus an optional `blockers[]` escape hatch). Derived fields (`kind`, `files`, `firstSha`, `lastSha`, `commitCount`, `requiresAgentResolution`, `index`) are computed by `enrichPlan` from the draft + analyzer, so the model cannot get them wrong. On validator errors, the previous draft + violation list are fed back as the next user prompt; internal retry loop (default 3, configurable). Output: a valid plan or a typed error.

- **`intake-validate.ts`** — deterministic post-enrichment validator. Debug-accessible as `cascade intake-validate <analyzer.json> <plan.json>`; normally runs inside `cascade triage` between each retry. Rules:
  1. **Cache-key attestation** — `plan.cacheKey === analyzer.cacheKey`.
  2. **Contiguity + coverage** — every analyzer commit is in exactly one group, groups are contiguous in analyzer order, no reordering within a group.
  3. **No overlap** — groups partition the analyzer's commit sequence.
  4. **Break-point singletons** — every analyzer break point is a singleton group with `kind === 'break_point'`.
  5. **Intersection coverage** — every file in `analyzer.intersection` lands in at least one group with `attention >= 'light'`. Touchers whose (commit, path) is `whitespaceOnly` or inside a `revertedAt` rollback window are exempt; rename matches (`oldPath === path`) are always counted.
  6. **Conflict-resolution flag gating** — every `analyzer.predictedConflicts` file lands in a group with `requiresAgentResolution === true` (derived from `kind === 'conflict' || attention === 'heavy'`).
  7. **Inspection-verdict attention floors** — canonical tags from inspector verdicts force minimum attention per [inspection.md § Triage outcome mapping](inspection.md):
     - `discarded-all-adopt` → `heavy`
     - `discarded-mixed` / `discarded-inconclusive` / `introduced-mixed` / `introduced-inconclusive` / `introduced-all-remove` → ≥ `light`

- **`intake-upstream.ts`** — per-group merge executor, invoked once per approved group with the group's terminal SHA. Preconditions: clean worktree, not detached, `upto` resolvable. If `upto` is already reachable from HEAD → `noop`. Otherwise runs `merge-preserve` with `--no-ff --no-commit` and the crafted intake message; on clean-staged → commits; on conflicted index → returns structured `ConflictedFile[]` (stage-set → `both-modified` / `added-by-us` / `added-by-them` / `deleted-by-us` / `deleted-by-them` / `other`). Companion `--continue` and `--abort` modes. Strictly non-interactive; no prompting, no agent dispatch — the skill orchestrates both.

### Agent prompts

Authored as markdown with frontmatter under `.claude/agents/`. Loaded at runtime by `triage.ts` and `inspect.ts` — the body is the agent's system prompt, the frontmatter carries `model:`. No prompt strings duplicated in code.

- **`cascade-triage-intake.md`** — forms thematic groups from the analyzer output, respecting contiguity, break-point singletons, and inspection-verdict tag requirements. Emits `emit_plan` only; no prose.
- **`cascade-inspect-discarded.md`** — per-commit `adopt` / `remove` / `mixed` / `escalate` verdict for components whose focus files the target removed and upstream kept modifying. Anchors on past removal rationale, names upstream's value in `feature_narratives`. Never prescribes HOW to integrate.
- **`cascade-inspect-introduced.md`** — per-commit verdict for components whose focus files upstream added. Anchors on feature usefulness and default-to-remove triggers (telemetry, duplicate surface, external service dependency, hardcoded key, license-restrictive).
- **`cascade-resolve-conflict.md`** — drafts resolutions for a single conflicted file given three-way content + surrounding context + divergence entry. Proposes content and rationale; never writes, never `git add`s.

### Skill

- **`.claude/skills/cascade-intake/SKILL.md`** — orchestrates analyze → inspect (parallel) → triage → human plan approval → per-group merge loop → post-merge cleanup (where mechanically safe) → per-group `cascade check`. Working state lives under `.cascade/.intake/<cacheKey>/` at the repo root (gitignored; never `/tmp`), with `analyzer.json`, `divergence.txt`, `discarded-verdicts.json`, `introduced-verdicts.json`, `plan.json`, `progress.json`. Removed on full success; retained on abort as the resume signal. Per-group confirmation format is mandatory: name, kind, attention, outcome, functional_summary, grouping_rationale, tags, commit range — file paths omitted unless `--verbose`. See [SKILL.md](../../.claude/skills/cascade-intake/SKILL.md) for the full flow.

### CLI additions

Added to the `cascade` dispatcher:

- `cascade intake-analyze [--json] [--target <ref>] [--source <ref>]`
- `cascade divergence-report [--json] [-v] [--target <ref>] [--source <ref>]`
- `cascade inspect --analyzer <path> [--discarded-out <p>] [--introduced-out <p>] [--concurrency <n>] [--model <id>]`
- `cascade triage --analyzer <path> [--divergence <p>] [--discarded-verdicts <p>] [--introduced-verdicts <p>] [--out <p>] [--model <id>] [--max-retries <n>]`
- `cascade intake-validate <analyzer.json> <plan.json> [--json]`
- `cascade intake-upstream <upto-sha> --source <name> -m <msg> [--dry-run]`
- `cascade intake-upstream --continue [-m <msg>]`
- `cascade intake-upstream --abort`

### Config additions

`.cascade/config.yaml` gains three knobs consumed by the analyzer and skill (defaults in parentheses, see `version.ts` `DEFAULTS`):

```yaml
discarded_min_delta_lines: 10     # upstream churn on a discarded path to trigger discarded-inspection
introduced_min_file_lines: 50     # file size (lines) of an upstream-introduced path to trigger introduced-inspection
intake_whitespace_only: true      # annotate whitespace-only touches; disable for whitespace-semantic projects (Python/YAML/Make)
```

## Working state layout

Authoritative under `.cascade/.intake/<cacheKey>/` (gitignored):

| File | Producer | Consumer |
|---|---|---|
| `analyzer.json` | `cascade intake-analyze --json` | inspect, triage, validate, skill |
| `divergence.txt` | `cascade divergence-report` | triage (context), conflict resolver |
| `discarded-verdicts.json` | `cascade inspect` | triage, plan presentation |
| `introduced-verdicts.json` | `cascade inspect` | triage, plan presentation |
| `plan.json` | `cascade triage` | skill (per-group loop), human approval |
| `progress.json` | skill | resume after abort |

`<cacheKey>` binds every artifact in the directory to the exact range + merge-base; a stale plan loaded against a re-fetched source fails the validator's cache-key rule rather than silently applying to the wrong commits.

## Out of scope for Phase 1

| Phase | Deliverable |
|---|---|
| 2 | `version.ts` mutating + auto-bump; P2 propagation; edition snapshots; cross-repo patch handoff; `cascade-propagate` / `cascade-hotfix` |
| 3 | Adapter-coverage scanning; `cascade adapters` |
| 4 | P3 classification + reclassification |
| 5 | Full divergence annotation; upstream-candidate PR building |

Explicitly deferred within P1 itself:

- **Full-auto mode.** There is no path that lands a merge without a human yes on the plan. `autoApprove: 'low-risk-only'` can skip per-group prompts for `attention: none` groups the user opts into, but plan approval is always interactive.
- **`target_feature_overview`** on the introduced-file inspector input — drop-in enhancement; no schema change.
- **Per-hunk inspection verdicts.** The commit is the atomic decision unit; per-hunk splits require a restructured merge model and are out of scope.
- **Retroactive analysis** of already-merged upstream ranges. `intake-analyze` only operates on unmerged `base..source`.

## Done criteria for Phase 1

- `cascade intake-analyze` runs against a real `upstream/main ← core` range and emits both JSON and the pretty-print. Same range + same repo state produces byte-identical output (determinism).
- `cascade inspect` dispatches verdicts for every `discardedGroups[i]` and `introducedGroups[i]`, one per component, with schema-enforced output at the SDK boundary.
- `cascade triage` produces a validator-clean plan end-to-end on a real upstream range; the internal retry loop recovers from `unknown-commit` / `non-contiguous-group` / attention-floor violations without human intervention.
- `cascade intake-validate` catches every rule family (cache-key, contiguity, break-point singleton, intersection coverage, conflict flag, inspection-tag floors) via fixture tests.
- `cascade intake-upstream <sha>` lands each sub-merge as `--no-ff` with the crafted intake message; the squash-rejection rule from Phase 0 still holds.
- A real upstream pull runs end-to-end through `/cascade-intake`: analyze → inspect → triage → plan approval → per-group merges (with drafted conflict resolutions where needed) → post-merge `git rm` / adoption surfaces → `cascade check` clean at every step.
- On abort, `.cascade/.intake/<cacheKey>/` survives and the next `/cascade-intake` invocation resumes from `progress.json`. On success, it is removed.

## Risks and mitigations

- **Agent silently flipping behavior during conflict resolution.** The failure mode: a draft looks plausible, the human rubber-stamps it, and the target's diverged behavior shifts by accident.
  *Mitigation:* human review on every non-trivial resolution is mandatory; `divergence-report` before and after the intake run surfaces any shift in diverged surface. The skill never `git add`s agent output without explicit approval.

- **Triage producing a plan that hides risk in an unattended group.** A divergence-touching commit buried inside an `attention: none` group lets a silent behavior change through.
  *Mitigation:* the validator's intersection-coverage rule catches this by construction — any file in `analyzer.intersection` must land in a group whose `attention >= 'light'`. The only exemption is (commit, path) pairs that are whitespace-only or inside a rollback window, neither of which leaves diverged-surface content behind.

- **Plan staleness.** A plan approved against one fetched source gets applied after a re-fetch that added commits.
  *Mitigation:* `cacheKey` attestation in the plan, re-checked by the validator at every entry; a stale plan fails fast with `cache-key-mismatch`.

- **Inspector prompt bias from the orchestrator.** A free-form dispatch preamble could prime the inspector toward a verdict.
  *Mitigation:* `inspect.ts` assembles the input envelope mechanically — no orchestrator-authored framing enters the inspector context. The user prompt is literally the JSON envelope plus a boilerplate "call `emit_verdict`" instruction; the system prompt is the agent's `.md` body verbatim.

- **Triage-group over-coalescing.** The agent bundles unrelated subsystems under a single "grouping_rationale" that strains to explain them.
  *Mitigation:* the skill inspects `grouping_rationale` for the telltale "and joining unrelated subsystems" pattern and stops to request a re-triage split; the validator's break-point singleton + contiguity rules prevent the worst mechanical cases.

## Local pre-flight

- `cascade intake-analyze` and `cascade divergence-report` are read-only and safe to run anytime on a clean worktree.
- `cascade inspect` and `cascade triage` are read-only with respect to git but hit the Anthropic API — cost-bearing.
- `cascade intake-upstream --dry-run` validates the preconditions for a group merge without mutating.
- The full skill flow requires a clean tree and the target branch checked out; it will refuse otherwise.

## Open decisions to make before Phase 2

- **Retroactive P2 tagging for Phase-1-era intake merges.** Phase 2's `writeTag()` can either start flowing from its first live run (accepting untagged history) or backfill tags on the intake merges Phase 1 produced. Current lean: accept history as-is per Phase 2's stated scope.
- **Inline divergence comments.** Whether to recommend a comment grammar for non-obvious divergences to cut down Phase 5's annotation burden. Deferred; rely on `cascade divergence-report` for now.

## Implementation notes

- **Determinism is load-bearing.** The analyzer's output is hashed into `cacheKey`; every downstream artifact (verdicts, plan, progress) is keyed by it. Non-determinism anywhere in the chain breaks plan approval + resume semantics. The analyzer uses `rev-list --reverse --topo-order` for stable range ordering and sorts all derived sets. Any new signal added to `IntakeReport` must be deterministic for a fixed repo state.
- **Schema enforcement at the SDK boundary.** Both `emit_plan` and `emit_verdict` are `@anthropic-ai/claude-agent-sdk` `tool()` definitions with zod schemas; the SDK validates at decode time. A malformed tool call is a schema error, not a content error — the retry loop sees the zod issues verbatim.
- **Draft-vs-enriched schema split.** The agent only emits subjective fields. Everything derivable (kind, files, counts, resolution flag, index) is computed. This removes an entire class of "the model forgot to update a derived field" bugs and keeps the prompt focused on judgment calls.
- **Contiguity over thematic purity when they conflict.** Upstream commit order is physics, not a choice. A thematic group that would require reordering must instead split around the break, and the validator enforces it.
- **Conflict resolver never touches the index.** The agent proposes; the human accepts; the skill writes the accepted content and `git add`s. This keeps the "never merge without a yes" contract even when resolutions are routine.
- **Post-merge cleanup is part of the group's approval.** The user's yes on the group covered the cleanup (`introduced-all-remove`, mechanical `git checkout` for narrow discarded-mixed adopts). Anything judgment-heavy (port, rewrite, re-home) surfaces as a reviewer action, never auto-applied.

## Kickoff order

1. `intake-analyze.ts` + determinism test fixture. Everything downstream reads its output, so this is the foundation.
2. `divergence-report.ts` minimal surface + text/JSON output. Independent of the rest; small.
3. `intake-validate.ts` with the full rule set against synthetic fixtures. Ready before triage is wired in, so triage has something to fail against.
4. `intake-upstream.ts` + `--continue` / `--abort`. Independent of the agent pipeline; lets the skill's merge loop be tested end-to-end with a hand-written plan.
5. Agent prompt markdown files: `cascade-inspect-discarded`, `cascade-inspect-introduced`, `cascade-triage-intake`, `cascade-resolve-conflict`. Reviewed as prose before any SDK wiring.
6. `inspect.ts` — input assembly + bounded-concurrency SDK dispatch. Test with a `dispatch` stub that returns canned verdicts.
7. `triage.ts` — SDK dispatch + enrichment + validator retry loop.
8. `cascade-intake` skill: glue, working-state management, per-group confirmation prompts, per-file conflict loop.
9. End-to-end rehearsal on a real upstream range. Iterate on agent prompts based on what the human notices during approval.
