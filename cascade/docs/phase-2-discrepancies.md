# Phase 2 — discrepancies from requirements and phase-2.md

Running log of places where the implementation diverges from the canonical documents, so future reviewers can decide whether to update the docs, the code, or both.

## Modules and channels carry no versions of their own

**Requirements §6** (`docs/FLSCLAW-BRANCHING-REQUIREMENTS.md`) mandates versions for `edition/<name>` and `deploy/<name>`, and explicitly *opts modules out* (“modules need no versioning of their own; they are tied to `core` and travel with its version”). Channel and skill branches are not mentioned at all — §6 neither requires nor forbids per-branch versions for them.

**Cascade implementation** (post-resolution) tags only first-class artifacts: `core/A.B.C.D`, `edition/<name>/A.B.C.D`, `deploy/<name>/A.B.C.D`, and `skill/<name>/A.B.C.D` (plus `skill/<s>/<c>/A.B.C.D`). Modules and channels are marked `not_versioned: true` in `.cascade/branch-classes.yaml` — propagate still merges core into them so they don't drift, but writes no `<branch>/A.B.C.D` tag.

**Rationale.** The distinction is between independent artifacts and supporting carriers:

- **Skills** are first-class deliverables. They have an independent lifecycle — a skill can evolve, ship, and be consumed at its own cadence. "What version of skill X is in edition Y?" is a real question, answered cheaply by a tag.
- **Modules and channels** are carriers bound to core. A module is a structural partition of core; a channel is a transport adapter for core. Neither has an independent lifecycle — if either diverges from core, that's a bug (caught by `check.ts` tag-discipline and prefix-mismatch rules), not a feature to record. A version tag on them would be a redundant restatement of core's version at the last propagate.

The earlier "deliberate deviation from §6" framing in `versioning.md` — that per-branch tags make edition snapshots self-contained — turned out to be partly aspirational: the snapshot schema already records included channels/modules by **name**, not version. No current consumer reads per-module or per-channel tags, and the question "what channel version shipped in edition X?" is not meaningful under the carrier framing — it collapses to "what version of core shipped in edition X?", which the core tag still answers.

**Impact on Phase 2 code.** `planPropagation` and `executeHop` intercept not-versioned targets: they still schedule and execute the merge (keeping channels/modules aligned with core) but skip `planBump` and tag writing. `versionSourceOf` continues to work for them so that an edition declaring `parent_branch: module/X` can still derive its prefix via the bootstrap path (module → core → upstream). The edition-snapshot schema is unchanged.

**Status.** Resolved. Requirements §6 and `versioning.md` should be amended in a future doc pass to ratify "modules and channels are not versioned; skills are." Skills remain a live gap in §6 — they deserve explicit inclusion on the versioned side.

**Test follow-up.** `propagate.test.ts`, `propagate-execute.test.ts`, `bump.test.ts`, and `tag-discipline.test.ts` still assert the old uniform-tagging behavior for module/channel fixtures and need to be updated to expect merge-only hops with no predicted tags.

## Orchestration shipped as skills, not plain slash commands

**phase-2.md § Slash commands** prescribes plain slash command files at `.claude/commands/cascade-propagate.md` and `.claude/commands/cascade-hotfix.md`, reasoning that P2 has no LLM steps and so doesn’t need skill-local prompts.

**Cascade implementation** ships `.claude/skills/cascade-propagate/SKILL.md` (and will ship the hotfix counterpart the same way in Step 5). Rationale: skills are callable by both operators and other agents with the same entry point; the no-LLM-in-the-loop doctrine still holds because decisions live inside the CLI’s deterministic planner and structured halts, not inside the wrapper.

**Status.** phase-2.md § Slash commands paragraph is now stale and should be rewritten to § Skills in a follow-up doc pass.

## Test fixtures are recipes executed at test time, not cached git bundles

**phase-2.md § CI wiring** calls for checked-in `.gitbundle` fixtures under `cascade/tests/fixtures/`, rebuildable via `rebuild.sh` from `recipes/<name>.sh`, with bundles as a cache.

**Cascade implementation** uses the existing programmatic `cascade/tests/fixtures.ts` helpers for unit + integration coverage. Bash recipes executed at test time are planned for the halt-matrix integration tests and will land alongside Step 4–6 coverage; no cached bundle artifact is committed. Rationale: fixture setup cost is low enough that executing the recipe per test is simpler than maintaining a recipe-bundle pair, and there’s no drift risk.

**Status.** Deliberate simplification accepted during planning. phase-2.md § CI wiring paragraph should be updated to drop the bundle-cache language.

## Deferred within Step 1 / Step 3

Captured for completeness — these are “not yet implemented,” not “diverging”:

- **`seed-consistency` warning** (phase-2.md § `check.ts`). Code stub not landed in Step 1; deferred until after the first real seed-written tag exists, since the check needs baseline-at-seeded-commit logic that hasn’t paid rent yet.
- **`prefix-mismatch` promotion to merge-commit enforcement** (phase-2.md § `check.ts`). Phase 0 has fixture-level enforcement only; the real-enforcement pass is deferred until Step 4’s execution surface is fully wired, to avoid a round-trip through `check.ts` before propagate can raise the same halt at merge time.
- **Slash command for hotfix** → will ship as a skill (`.claude/skills/cascade-hotfix/`) when Step 5 lands, consistent with the propagate decision above.

## Step 5 — hotfix flow

**Skill, not plain slash command.** `.claude/skills/cascade-hotfix/SKILL.md` ships as a skill, consistent with the propagate decision above. phase-2.md § Slash commands still mentions `.claude/commands/cascade-hotfix.md`; same doc pass as propagate will cover it.

**Cherry-pick conflict halt reuses `merge-conflict`.** Registry is a closed set; introducing `cherry-pick-conflict` would mean a doc + envelope-schema change for no operational gain. The halt envelope carries `details.operation: "cherry-pick"` so consumers can still disambiguate. Applies to `cascade hotfix --cherry-pick` only.

**Ephemeral `hotfix/<slug>` is not auto-deleted by `--continue`.** Leaves the operator's local work and reflog intact; `cascade check`'s ephemeral fallback won't flag it. Deliberate: deleting would be a surprise to operators who still have uncommitted work on the branch.

**Bounded walk on `deploy/*` tips is committer-date `--since`, not rev-count.** `cascade hotfix --continue` and `check.ts hotfix-loop-open` both scan with `git log --first-parent --since="<warn_days × 2> days ago"`. First-parent matches the operator mental model (skip side-branch merge parents); committer-date bounds scale the scan naturally as stale pairs age out.

**`cascade check hotfix-loop-open`'s reverse-direction heuristic.** When scanning a deploy tip for cherry-picks, the rule must distinguish forward cherry-picks (trailer points at an ephemeral SHA *not* reachable from deploy) from the reverse-direction merge commit that propagation eventually carries down (trailer points at a cherry-pick SHA *that is* reachable). Implemented as: skip any pair-trailer commit whose paired SHA is an ancestor of the deploy tip.

## Reminder to reviewers

Add an entry here before merging any PR that lands behaviour differing from what `phase-2.md` or requirements §6 states. Linking the divergence from here keeps the doctrine-vs-code mismatch visible rather than quietly drifting.
