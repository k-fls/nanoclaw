# Processes P1–P5

Implements [§11 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md).

## Three tiers

- **Scripts** (`cascade/scripts/*.ts`) — deterministic mechanics. No LLM. Always safe to re-run.
- **Agent subroutines** — LLM calls bounded to exactly two places:
  - `fls-resolve-conflict` — draft a resolution for a P1 merge conflict given the three-way diff and surrounding code.
  - `fls-classify-ambiguous` — draft a classification recommendation for a P3 hunk where signals disagree.
  Both propose only. Neither writes to disk.
- **Humans** — confirm any merge into a long-lived branch. Make ownership decisions for unowned new files. Accept, edit, or reject agent drafts.

Slash commands (`.claude/commands/fls-*.md`) orchestrate each process: run the script, dispatch an agent subroutine if the script hits something non-mechanical, present the result, ask confirmation, execute the mutating half.

## P1 — Upstream intake

**Input:** new commits on upstream main and upstream skill branches.
**Output:** updated `core` and updated `channel/<name>` branches.

1. `intake-upstream.ts` fetches upstream, computes the merge range per branch.
2. For each conflicted file:
   - Script presents three-way diff and relevant file context.
   - If the conflict is non-trivial, dispatch `fls-resolve-conflict` with the diff, surrounding code, and (if any) nearby inline comments. Agent drafts a resolution and rationale.
   - Human reviews and accepts/edits/rejects.
3. `merge-preserve.ts` performs the `--no-ff` merge with the resolved content.
4. `version.ts` auto-bumps per [versioning.md](versioning.md).

Default resolution rule (§7): prefer fls behavior where fls has diverged. Reviewer confirms the default applied correctly and that behavior wasn't silently flipped.

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
3. **Low-confidence** proposals (signals disagree, or ambiguous): presented individually with top-2 candidate homes and signal explanations. `fls-classify-ambiguous` agent may draft a recommendation.
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
