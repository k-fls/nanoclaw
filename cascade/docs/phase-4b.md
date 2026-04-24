# Phase 4b — P3 reclassification, mutating

Scope for the mutating half of P3. Consumes 4a's classifier and turns accepted proposals into ephemeral branches, cherry-picked hunks, open PRs, and follow-up plans. Includes the inline-removal reconciler that closes the loop on the source branch after P2 carries the relocated change back. Highest-risk phase in the roadmap; gated on 4a validation.

Implements the mutating surface of [§10 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md) and [P3 of processes.md](processes.md#p3--reclassification).

## Gate

Phase 4b does not start until 4a's validation threshold (see `phase-4a.md § Done criteria`) is met on the shadow set. This is a hard gate, not a soft one.

## In scope

### Scripts (`cascade/scripts/`)

- **`reclassify.ts`** — consumes classify output, creates ephemeral branches off proposed homes, cherry-picks hunks, emits PRs (in-repo) or patch + metadata (cross-repo, reusing the Phase 2 patch-handoff contract). Per-change, not per-commit: splits commits where hunks belong to different homes.
- **Inline-removal reconciler** — separate code path, not a flag on `reclassify.ts`. Reads follow-up plans, checks whether the required P2 tag has propagated to the source branch, transitions plan state. Never removes without an explicit second invocation.
- **`check.ts` additions** — new halt-registry rules for stale/orphaned follow-up plans.

### Agent prompts

- **`cascade-classify-ambiguous.md`** — drafts a recommendation for a single low-confidence hunk given the two top candidate homes and signal scores. Propose-only; never writes.

### Skill

- **`.claude/skills/cascade-reclassify/SKILL.md`** — orchestrates classify → batched accept for high-confidence proposals → individual walkthrough for ambiguous ones (with agent draft) → `reclassify.ts` execution → follow-up plan creation. Working state under `.cascade/.reclassify/<id>/`.

### Sidecar artifacts

- **`.cascade/reclassify/<id>.json`** — follow-up plan per relocation batch. Schema includes source branch, relocated hunk IDs, proposed home, relocation ref, outcome choice, P2-confirmation gate, inline-removal status. Checked into source branch.

### CLI additions

- `cascade reclassify --from-report <path> [--dry-run]`
- `cascade reclassify --reconcile` (updates follow-up plan states)
- `cascade reclassify --remove <id>` (explicit inline-removal commit)
- `cascade reclassify --list [--status <state>]`

### Tests

- End-to-end fixture covering: classify → accept → relocate → simulated P2 propagation → reconcile → remove.
- Third-outcome path (keep deployment-specific delta) tested separately.
- Negative tests: `--remove` refuses when P2 confirmation gate is not satisfied; refuses when source hunk is missing from source history.

## Out of scope

- v2 signals (still deferred).
- Automatic acceptance of any classification. Every relocation, every inline removal, every keep-delta decision requires explicit human confirmation — mechanically enforced, not documented-only.
- Changes to Phase 2's propagation logic. Reclassify consumes P2 tags as read-only ground truth.

## Dependencies

- Phase 4a (signals + CLI + validation threshold).
- Phase 2 (P2 propagation must be working end-to-end — the inline-removal gate depends on tags reaching the source branch).
- Phase 0 (`merge-preserve.ts` for any merge commits; `bypass.ts` closed-set extension for new check rules).

## Done criteria

From `phases.md § Phase 4`:

- Shadow mode has demonstrated v1 signals produce usable proposals on real history (4a deliverable, restated as entry gate).
- A real source-branch range reclassifies end-to-end with human confirmation at each step.
- No follow-up plan removes an inline version without P2 confirmation — enforced by code, not convention.
- Third-outcome (relocate clean version + keep deployment-specific delta) supported end-to-end.

## Risks

- **Inline-removal on source** is the single highest-risk mutation in cascade. Three independent safety layers: mechanical P2-confirmation gate, explicit second-command `--remove`, human confirmation in the skill. None may be collapsed.
- **Cross-repo relocation** reuses Phase 2's patch-handoff path; no new cross-repo machinery invented here.
- **Classify drift between 4a validation and 4b execution.** If signal definitions change after 4a's threshold was set, the threshold is stale. Any signal change reruns shadow validation before 4b executes again.
