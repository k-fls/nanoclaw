# Phase 2 Step 5 — hotfix flow (task handoff)

**Status: done.** `cascade/scripts/hotfix.ts`, CLI subcommands, `hotfix-loop-open` check rule, `.claude/skills/cascade-hotfix/SKILL.md`, and `cascade/tests/hotfix.test.ts` (13 tests) landed. Full cascade suite green at 253 tests (was 240). Discrepancies logged in `phase-2-discrepancies.md § Step 5 — hotfix flow`. Step 6 (downstream walkthrough) ready to start.



Self-contained brief for the next agent picking up the hotfix implementation. Steps 1–4 (tag surface, edition snapshot, propagate planner + executor, `cascade-propagate` skill) are landed and on green. This step is deliberately scoped to be isolated: it consumes Steps 1–2 surfaces and adds no changes to any existing script beyond `cli.ts` and `check.ts`.

## Goal

Implement the two-target hotfix pattern from `cascade/docs/phase-2-hotfix.md`: shepherd an operator through `core → hotfix/<slug> → deploy/<name>` and `hotfix/<slug> → core`, tag the deploy on cherry-pick, write symmetric `Cascade-Hotfix-Pair:` trailers, and add the `hotfix-loop-open` check that recognises loop closure after propagate carries the core-side fix back down.

## Scope — what to build

### Script: `cascade/scripts/hotfix.ts` (new)

Three entry points corresponding to the three-invocation flow (all read-and-write against git; no cascade sidecar files):

1. **`start(deployBranch, slug, repoRoot)`**
   - Creates ephemeral branch `hotfix/<slug>` off `core` (or `main` during the transitional alias).
   - Leaves HEAD on the new branch.
   - Rejects if `hotfix/<slug>` already exists. Rejects if `deployBranch` isn't `deploy/<name>` class.
   - `deployBranch` is accepted for symmetry with the CLI but stored only in the operator's head — no sidecar persistence (the contract is explicit re-passing at step 3).

2. **`cherryPick(deployBranch, repoRoot)`**
   - Cherry-picks the current HEAD of `hotfix/<slug>` (or detects the single most-recent `hotfix/*` ephemeral) onto `deployBranch`.
   - Writes `Cascade-Hotfix-Pair: <ephemeral-core-sha>` into the cherry-picked commit's trailer block via `git interpret-trailers --in-place` (must survive rebase/cherry-pick).
   - Runs `cascade tag deployBranch` internally — a pure `D++` on the deploy's existing `A.B.C` (cherry-pick doesn't advance a source prefix). Uses the `writeTag()` + `planBump()` chain from Step 1.
   - On `cherry-pick` conflict: halt with `merge-conflict` (or `cherry-pick-conflict`; see "open question" below); operator resolves + continues manually; re-invocation detects state.

3. **`continueFlow(handle, repoRoot)`**
   - `handle` is either `<ephemeral-core-sha>` or branch name `hotfix/<slug>`. Normalise both to the ephemeral's tip SHA.
   - Merges the ephemeral into `core` (history-preserving via `merge-preserve.ts`).
   - Re-derives the deploy-side cherry-pick SHA at invocation time: scan every local `deploy/*` tip (bounded commit walk, say `hotfix_loop_warn_days × 2` days by default, matching the check) for a commit whose trailer contains `Cascade-Hotfix-Pair: <eph-sha>`. `eph-sha` is unique enough; no deploy-branch argument needed.
   - Writes the reverse trailer `Cascade-Hotfix-Pair: <deploy-cherry-pick-sha>` on the core-side merge commit.
   - **Does NOT auto-tag `core`** — the next `cascade propagate` owns that surface.
   - Deletes the ephemeral after the merge lands (nice-to-have; leaving it is fine too — the next `check.ts` pass on ephemerals won't flag it).

### Check rule: `hotfix-loop-open` (append to `check.ts`)

- Severity: `warning`.
- Scope: every `deploy/*` tip, bounded commit-walk window set by `hotfix_loop_warn_days × 2` (default 28 days — the config key is already loaded in Step 1).
- Algorithm: for each cherry-pick commit on `deploy/*` carrying `Cascade-Hotfix-Pair: <eph-sha>`, verify a commit reachable from the deploy tip's first-parent history carries a pair-trailer `Cascade-Hotfix-Pair: <deploy-cherry-pick-sha>` originating from the `core` side. If that commit is missing and `warn_days` has elapsed since the cherry-pick, emit the warning.
- Bypass-log rule name: `hotfix-loop-open` (add to the `bypass.ts` closed-set validator).

### CLI subcommands (append to `cli.ts`)

```
cascade hotfix <deploy-branch> <slug>
cascade hotfix --cherry-pick <deploy-branch>
cascade hotfix --continue <handle>
```

Exit codes: 0 on success, 1 on halt (merge-conflict, cherry-pick-conflict, missing pair, etc.), 2 on usage error. Halt output follows the envelope shape from `cascade/scripts/propagate.ts` (reuse `HaltEnvelope` or mirror its shape).

### Skill: `.claude/skills/cascade-hotfix/SKILL.md` (new)

Pattern it on `.claude/skills/cascade-propagate/SKILL.md`:

- Frontmatter: `name: cascade-hotfix`, description triggers on "hotfix", "cherry-pick a fix to deploy", "emergency deploy fix".
- Preconditions: clean worktree, `cascade check` OK, `core` exists.
- Flow: the three invocations with human confirmation before each write. Explicit warning about the **cherry-pick-amend-after-`--continue` sharp edge** (see `phase-2-hotfix.md § Sharp edge`).
- Recovery instructions (lost handle between steps): `git branch --list 'hotfix/*'` or `git reflog`. Do NOT grep `core` for the pair trailer — the core-side merge hasn't happened yet.
- Non-goals: same list as the propagate skill (no LLM in the decision path, no auto-resolve, no push).

## Spec references (authoritative)

- `cascade/docs/phase-2.md § hotfix.ts` — deliverable, CLI surface, config key, risk section.
- `cascade/docs/phase-2-hotfix.md` — full flow, state transitions, trailer mechanics, recovery, sharp edge. Primary source.
- `cascade/docs/artifacts.md § bypass-log` — append `hotfix-loop-open` to the closed-set rule column.
- `cascade/docs/versioning.md § D-bump rules` — "Merge from non-source (sibling, ephemeral), direct commit → no auto-bump; `cascade tag <branch>` to release." The cherry-pick into deploy is that case; step 3's auto-tag is the deliberate exception because cascade runs the tag internally.

## What to assume exists (Steps 1–4 surfaces)

- `cascade/scripts/tags.ts` — `writeTag()`, `TagExistsError`, body template, refuse-to-overwrite.
- `cascade/scripts/version.ts` — `planBump()`, `loadConfig()` (returns `hotfix_loop_warn_days`), all error types.
- `cascade/scripts/merge-preserve.ts` — `mergePreserve(source, opts, repoRoot)` for the `--continue` merge into core.
- `cascade/scripts/branch-graph.ts` — `classOf`, `isEphemeral`, `isLongLived`, `loadRegistry`, ref helpers.
- `cascade/scripts/bypass.ts` — bypass-log reading + `validateEntry` with closed-set rule names.
- `cascade/scripts/propagate.ts` — `HaltEnvelope`, `remediationFor()` (export if reusing; currently module-local).

No changes required to propagate / edition-snapshot / snapshot-schema / version / tags / merge-preserve.

## Done criteria

From `cascade/docs/phase-2-hotfix.md § Done criteria`:

- `cascade hotfix <deploy> <slug>` produces the ephemeral branch off core.
- `cascade hotfix --cherry-pick <deploy>` produces a commit on `deploy/<name>` with the `Cascade-Hotfix-Pair` trailer **and** an auto-written `deploy/<name>/<A.B.C.(D+1)>` tag via `writeTag()`.
- `cascade hotfix --continue <handle>` (exercised with **both** handle forms: SHA and `hotfix/<slug>`) writes the reverse trailer on `core`'s merge commit. Does not tag core.
- After a simulated propagate chain that carries the core fix back down to `deploy/<name>`, `check.ts` reports `hotfix-loop-open` as **closed** (rule does not fire).
- Amend-before-step-4: after the operator amends the cherry-pick on `deploy` before running `--continue`, the re-derivation picks up the new SHA and the loop closes correctly.
- Amend-after-step-4: loop does NOT close. Emit the warning at the next `check.ts` run. Document the sharp edge in the skill prose.

## Test coverage (minimum)

Follow the `cascade/tests/fixtures.ts` programmatic pattern (recipes-at-test-time alternative also acceptable for the multi-step scenarios). New file: `cascade/tests/hotfix.test.ts`.

- Happy path: start → cherry-pick → continue, both trailers present, deploy tag at `D+1`.
- Handle forms: `--continue <eph-sha>` and `--continue hotfix/<slug>` produce identical results.
- Amend before step 4: deploy cherry-pick amended, `--continue` re-derives correctly.
- Amend after step 4: loop stays open; `hotfix-loop-open` check fires.
- Conflict on cherry-pick: halt, HEAD left on deploy, re-invocation picks up.
- `check.ts hotfix-loop-open` fires after `warn_days` elapse with a missing reverse trailer; does not fire before `warn_days`.
- `check.ts hotfix-loop-open` closes (does not fire) once the pair is reachable from the deploy tip via propagation.
- Bypass-log entry with rule `hotfix-loop-open` suppresses the warning.

## Discrepancies to register

Append to `cascade/docs/phase-2-discrepancies.md`:

- Skill (not plain slash command) — carried forward from propagate.
- Anything the implementation learns that diverges from `phase-2-hotfix.md` while drafting the flow.

## Open questions to resolve during implementation

These are genuinely open — not yet decided in the docs. The implementing agent should pick a direction, document it in `phase-2-discrepancies.md`, and proceed.

- **Cherry-pick conflict halt kind.** Reuse `merge-conflict` (consistent with the halt registry) or introduce `cherry-pick-conflict` as a distinct kind? Registry is a closed set; adding one is a doc change. Recommended: reuse `merge-conflict` with `details.operation: "cherry-pick"` to avoid registry churn.
- **Ephemeral cleanup after `--continue`.** Delete `hotfix/<slug>` automatically or leave it? Spec allows either. Recommended: leave it; the operator (or next `cascade check`) can clean up. Reduces surprise if the user has local work there.
- **Bounded commit walk on `deploy/*` tips for pair-trailer scan.** Spec says "warn_days × 2". Implement as `git log --since="<warn_days × 2> days ago"` on each `deploy/*` tip, limited to first-parent history. Confirm this matches the operator's mental model (first-parent skips merge-commit side branches).

## What NOT to do in Step 5

- Don't refactor `propagate.ts`, `version.ts`, `tags.ts`, `merge-preserve.ts`, `edition-snapshot.ts`, `snapshot-schema.ts`. Step 5 is additive.
- Don't auto-tag `core` in `--continue`. `cascade propagate` owns that surface.
- Don't implement Step 6 (downstream walkthrough). Keep the scope to source-repo hotfixes.
- Don't push tags or branches anywhere.
- Don't commit, stash, or push without explicit user confirmation (repo-wide rule — see `CLAUDE.md`).

## Kickoff checklist for the agent

1. Read `cascade/docs/phase-2-hotfix.md` end-to-end, then `cascade/docs/phase-2.md § hotfix.ts` and § Risks.
2. Read the existing `.claude/skills/cascade-propagate/SKILL.md` — pattern for tone, preconditions, output style.
3. Read `cascade/scripts/propagate.ts` — for envelope shape, halt handling, and the executor's re-plan-at-execution-time pattern (applies here for the cherry-pick auto-tag step).
4. Start with `hotfix.ts` (core logic, no CLI), land with unit tests, then wire `cli.ts`, then add the `check.ts` rule, then the skill.
5. Run `cd cascade && npx tsc --noEmit && npx vitest run` before handing off. All 240 existing tests must still pass.

## Reporting back

On completion, the agent updates:

- `cascade/docs/phase-2-discrepancies.md` with any new deviations.
- This file — mark done or note blockers.
- Status comment on whether Step 6 (downstream walkthrough) is ready to start.
