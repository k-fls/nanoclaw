# Processes P1–P5

Implements [§11 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md).

## Three tiers

- **Scripts** (`cascade/scripts/*.ts`) — deterministic mechanics. No LLM. Always safe to re-run.
- **Agent subroutines** — LLM calls bounded to three places:
  - `cascade-triage-intake` — read the P1 analyzer JSON; partition the ordered commit list into thematic groups; assign attention / expected-outcome / functional-summary per group. Runs via schema-enforced tool use; derived fields computed post-hoc.
  - `cascade-resolve-conflict` — draft a resolution for a P1 merge conflict given the three-way diff and surrounding code.
  - `cascade-classify-ambiguous` — draft a classification recommendation for a P3 hunk where signals disagree.
  All propose only. None writes to disk.
- **Humans** — confirm any merge into a long-lived branch. Make ownership decisions for unowned new files. Accept, edit, or reject agent drafts.

Slash commands (`.claude/commands/cascade-*.md`) orchestrate each process: run the script, dispatch an agent subroutine if the script hits something non-mechanical, present the result, ask confirmation, execute the mutating half.

## P1 — Upstream intake

**Input:** new commits on upstream main and upstream skill branches.
**Output:** updated `core` and updated `channel/<name>` branches.

### Pre-merge analysis and decomposition

1. **`intake-analyze.ts`** fetches upstream, computes the merge range, and emits a structured report: per-commit signals (primaryKind + files + tags + parents + author/date), aggregate file set, fls-divergence intersection, conflict prediction via `git merge-tree`, upstream break points (tags / upstream merge commits), rename tracking, and fls-deletion groups (files fls deleted that upstream kept modifying, grouped by the fls deletion commit). Per-commit `primaryKind` is drawn from `{clean, divergence, conflict, structural, break_point}`:

   | Kind | Rule |
   |---|---|
   | `clean` | no predicted conflicts, no intersection with the divergence set |
   | `divergence` | touches a file in the fls divergence set |
   | `conflict` | predicted conflict, no divergence-set intersection |
   | `structural` | merge commit (>1 parents), large rename, or apparent revert |
   | `break_point` | marker at an upstream tag or upstream merge commit |

   Read-only; deterministic; cacheable by `(from_sha, to_sha, merge_base)`. The analyzer does not group commits — it emits signals the triage agent partitions.

2. **`cascade triage`** runs the `cascade-triage-intake` agent via the Claude Agent SDK with decode-time schema enforcement (one tool, `emit_plan`, whose input schema is the plan draft). The agent partitions the ordered commit list into thematic groups, assigning only subjective fields (name, attention, expected_outcome, mechanical_complexity, tags, functional_summary, grouping_rationale). Derived fields (kind, files, firstSha/lastSha, commitCount, requiresAgentResolution, index) are computed by `enrichPlan` after the tool call. The agent has read-only repo access (`Read`, `Glob`, `Grep`, `Bash` limited to `git show`/`log`/`diff`/`blame`) for inspecting actual code changes, with a size heuristic: inspect small/medium diffs; raise huge commits to `attention: heavy` rather than attempting to summarize them.

3. **Validator** (`intake-validate`) runs on the enriched plan inside `cascade triage` and enforces plan invariants: cache-key match, contiguity + coverage + non-overlap of commits across groups, break-point singletons, intersection-coverage attention floor, predicted-conflicts-require-resolution-flag, deletion-rationale attention floors. On violations, triage re-invokes the agent with the failed plan and violations as input; up to `--max-retries` (default 3) before surfacing an error.

4. **Human reviews the validated plan.** Accepts as-is, edits grouping, or aborts. Triage only returns plans that pass validation.

### Per-group merge loop

5. For each approved group, `intake-upstream.ts` performs the merge. For each conflicted file:
   - Script presents three-way diff and relevant file context.
   - If the conflict is non-trivial, dispatch `cascade-resolve-conflict` with the diff, surrounding code, and (if any) nearby inline comments. Agent drafts a resolution and rationale.
   - Human reviews and accepts/edits/rejects.

6. `merge-preserve.ts` performs the `--no-ff` merge with the resolved content.
7. `version.ts` auto-bumps per [versioning.md](versioning.md).

Default resolution rule (§7): prefer fls behavior where fls has diverged. Reviewer confirms the default applied correctly and that behavior wasn't silently flipped.

### Decomposition safety

Groups are contiguous ranges in upstream's history — the agent partitions an ordered list, it doesn't reorder or skip. Each group's commits stay in analyzer order. Group boundaries are the agent's only freedom; the validator enforces contiguity, coverage, and non-overlap. Each sub-merge leaves the tree buildable before the next one starts.

## P2 — Downstream propagation

**Input:** updated core, updated channels, updated skills, updated adapters.
**Output:** updated editions; updated deployments.

1. `propagate.ts --dry-run` computes the merge sequence per [branch-model.md](branch-model.md)'s ongoing merges, in the order that keeps prefixes aligned (upstream → core → leaves → editions → deploys).
2. Operator reviews the sequence.
3. `propagate.ts` executes merges via `merge-preserve.ts`. Each merge:
   - Refreshes the target from its version source first if prefix is stale.
   - Auto-bumps and tags per the rules.
   - Halts on any prefix mismatch not covered by `parent_branch`.
4. Deployments move forward only when explicitly propagated; no silent updates.

Cross-repo deploys: default path is patch handoff (emit `.patch` + metadata to apply in the deploy repo). Opt-in: forge API creates the PR directly.

## P3 — Reclassification

**Input:** source branch + commit range.
**Output:** per-change relocation proposals; escalation list; follow-up plans.

### Signals (v1)

- **Path-ownership** — the file's owner is the proposed home. Strong signal when the file is owned by exactly one non-core branch.
- **Size/shape** — minimal integration edits (per §8) in a core-owned file are attributed to the thing being integrated, not to core.
- **Diff-vs-upstream** — on core-owned files, distinguishes fls-divergence maintenance (stays on core) from layer-specific changes.

Signals v2 (later): symbol-dependency, import-graph, co-change, test-location, string-literal.

Signals are combined as a rule cascade, not a weighted vote — deterministic rules are explainable in escalations.

### Flow

1. `classify-change.ts` runs read-only, emits proposals with signal scores and confidence tier.
2. **High-confidence** proposals (all signals agree, single candidate home): batched, one-click accept/reject.
3. **Low-confidence** proposals (signals disagree, or ambiguous): presented individually with top-2 candidate homes and signal explanations. `cascade-classify-ambiguous` agent may draft a recommendation.
4. Human confirms each relocation. Commits split where hunks belong to different homes.
5. `reclassify.ts` creates ephemeral branches off proposed homes; cherry-picks hunks; opens PRs (in-repo or cross-repo).
6. Records follow-up plan in `.cascade/reclassify/<id>.json`:
   - When the relocation lands in its home, P2 propagates it down through the edition back to the source.
   - Once the propagated version has landed on the source AND CI is green, reconcile the original inline version on the source (revert it, or keep as a deployment-specific delta on top of the propagated version — human choice at P3 time).
7. **Inline removal is gated on P2 confirmation.** Never remove until the propagated version has actually arrived.

### Deployment-specific delta option

When the inline version on the source was adapted to deployment context (not functionally identical to what ends up in the clean home), P3 offers a third outcome in addition to "revert inline, take propagated" and "escalate": *relocate clean version to the proper home, keep a thin deployment-specific delta on top of the propagated version.* Human chooses at P3 time.

## P4 — Divergence review

Divergences are what `git diff core..upstream/main` shows. No mandatory registry.

1. `cascade divergence-report` generates a reviewable diff grouped by file and function.
2. Human annotates entries as "keep," "upstream-candidate," "obsolete — plan removal," "investigate."
3. Annotations live in commit messages on `core` or in the issue tracker. No sidecar YAML.

Light-touch. Reviews at a chosen cadence (quarterly recommended). Surfaces drift so it doesn't rot.

### When an inline comment helps

For a divergence where the *why* isn't evident from the diff (behavior difference behind a benign-looking line change), add a plain code comment at the site. No special grammar, no parser. Optional documentation, not tooling input.

## P5 — Upstream candidate review

1. `cascade upstream-candidates` lists divergences annotated as candidates from P4 or issue labels.
2. For each, helper builds a patch series against upstream's current tip and opens a draft PR upstream.
3. Outcome (accepted / rejected / closed / superseded) is recorded on the tracking issue or in commit trailers on the merge back to `core`.
4. A rejected candidate is not re-attempted automatically; the outcome is visible so reasons are preserved.

## Hotfix two-target (supporting flow)

Not one of the five processes, but a supported pattern — documented in [branch-model.md](branch-model.md). Used for production emergencies to avoid misusing P3 as an escape hatch.

## What the three tiers forbid

- No LLM touches versions, manifests, ownership maps, or propagation.
- No script merges into a long-lived branch without human confirmation.
- No agent proposal becomes authoritative without human review.
- No automatic classification becomes a merge without §11 P3 human confirmation.

If a future feature tempts the design to cross any of these lines, revisit [README.md § Design principles](README.md) before coding.
