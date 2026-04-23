# Phase 2 — Hotfix flow

Companion to [phase-2.md](phase-2.md). Covers the two-target hotfix mechanics split out of the main propagation spec because the flow interrupts the propagate narrative at three points (deliverable, CLI, state transitions) and benefits from a dedicated page.

Cross-refs back to phase-2.md: [§ `hotfix.ts`](phase-2.md#hotfixts), [§ CLI additions](phase-2.md#cli-additions), [§ Done criteria for Phase 2](phase-2.md#done-criteria-for-phase-2), [§ Risks](phase-2.md#risks-without-a-mechanical-mitigation-in-spec).

## Flow

The two-target hotfix pattern (see [branch-model.md § Hotfix two-target](branch-model.md)) coordinates an ephemeral branch, `deploy/<name>`, and `core`. `hotfix.ts` shepherds it through three invocations; the `Cascade-Hotfix-Pair:` trailer written symmetrically on both sides of the pair is what closes the loop.

Transitions (each arrow is one state transition; `A -> B` reads "A produces B"):

- `core -> hotfix/<slug>` — `cascade hotfix <deploy> <slug>` branches the ephemeral off `core`.
- `hotfix/<slug> -> hotfix/<slug>@<eph-sha>` — operator commits the fix; the new SHA is the step-3 trailer anchor.
- `hotfix/<slug>@<eph-sha> -> deploy/<name>` — `cascade hotfix --cherry-pick <deploy-branch>` cherry-picks onto the deploy, writes `Cascade-Hotfix-Pair: <eph-sha>`, and **auto-tags** `deploy/<name>` with a D++ bump. The `<deploy-branch>` argument is passed explicitly; the CLI holds no session state (consistent with "no `.cascade/` sidecar" — step 1's `<deploy-branch>` is not remembered).
- `hotfix/<slug> -> core` — `cascade hotfix --continue <handle>` merges the ephemeral into `core`. The cherry-pick SHA for the reverse trailer is re-derived at `--continue` time by scanning every local `deploy/*` tip (and walking back a bounded number of commits on each) for a commit whose trailer holds `Cascade-Hotfix-Pair: <eph-sha>`. `<eph-sha>` uniquely identifies the pair, so no deploy-branch argument is needed. An amend on the cherry-pick between steps 3 and 4 is picked up correctly — the pair trailer survives the amend because it's in the commit message. The core merge commit then gets `Cascade-Hotfix-Pair: <current-cherry-pick-sha>`. **No auto-tag on `core`** — the next `cascade propagate` handles it.
- `core ⇝ deploy/<name>` (via propagate chain `core → channel/* → edition/* → deploy/<name>`) — `cascade propagate` carries the core fix back down through the normal chain; the loop stays "open" until the final hop into `deploy/<name>` lands.
- `deploy/<name> (propagated merge) -> loop closed` — `check.ts` matches the pair trailer on the propagated merge to the cherry-pick and records the loop as closed.

Steps:

1. **`cascade hotfix <deploy-branch> <slug>`** — creates ephemeral `hotfix/<slug>` off `core` and hands HEAD to the operator. The `hotfix/` prefix is canonical: `check.ts`'s ephemeral-fallback class matches it, and recovery (`git branch --list 'hotfix/*'`) relies on it.
2. **Operator commits the fix** on `hotfix/<slug>` with plain `git add` / `git commit`. The resulting SHA is `<ephemeral-core-sha>` and is what the step-3 trailer references.
3. **`cascade hotfix --cherry-pick <deploy-branch>`** — cherry-picks the ephemeral onto the given `deploy/<name>`, writes `Cascade-Hotfix-Pair: <ephemeral-core-sha>` on the cherry-picked commit, **and runs `cascade tag deploy/<name>` internally** — a pure `D++` on the deploy's existing `A.B.C` (the cherry-pick advances no upstream prefix). Operator does not tag separately. The `<deploy-branch>` argument is re-passed explicitly; the CLI holds no session state from step 1.
4. **`cascade hotfix --continue <handle>`** — merges ephemeral into `core` same-day. `<handle>` is `<ephemeral-core-sha>` or the branch name `hotfix/<slug>` (the branch still exists locally between steps 3 and 4 — the operator's primary handle). The merge commit gains the reverse trailer `Cascade-Hotfix-Pair: <deploy-cherry-pick-sha>`, re-derived by scanning all local `deploy/*` tips for a commit carrying `Cascade-Hotfix-Pair: <ephemeral-core-sha>` — `<eph-sha>` is unique enough to identify the pair without a deploy-branch argument. **`--continue` does not auto-tag `core`** — the next `cascade propagate` tags it on the normal core path; running `cascade tag core` by hand would duplicate that path. No `.cascade/` sidecar consulted or written.
5. **Loop closure.** Once P2 propagates the `core` fix back down, `check.ts` sees the pair trailer on the propagated merge and matches it to the cherry-pick.

Asymmetry worth flagging: step 3 auto-tags `deploy/<name>` (no other route bumps a deploy); step 4 does not auto-tag `core` (propagate owns that surface). Both sides carry commit trailers; `check.ts` resolves pairs by grep on long-lived branches reachable from HEAD.

Recovery if the operator loses the handle between steps 3 and 4: `git branch --list 'hotfix/*'` or `git reflog`. Do **not** use `git log core --grep=Cascade-Hotfix-Pair:` — the core-side merge hasn't happened yet.

## Sharp edge: cherry-pick amend after `--continue`

If the operator amends the `deploy/<name>` cherry-pick *after* step 4 has already run, the pair goes out of sync: core's merge commit carries the pre-amend SHA in its trailer, deploy's cherry-pick is now at a different SHA, and `hotfix-loop-open` will not recognize the propagated merge as closing the pair. Amending *before* step 4 is fine — `--continue` re-derives the SHA at that point. Amending after is a sharp edge with no mechanical backstop; remediation is an explicit second amend on the core merge (or a follow-up commit) to re-align trailers.

## Done criteria

`cascade hotfix` produces a cherry-pick on `deploy/<name>` with a `Cascade-Hotfix-Pair` trailer; `cascade hotfix --continue <handle>` writes the reverse trailer on `core`; after P2 propagates the `core` fix back, `check.ts` closes the loop. Exercised with both handle forms (SHA and `hotfix/<slug>`), and with an amend-before-step-4 to verify re-derivation.
