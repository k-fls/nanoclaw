---
name: cascade-hotfix
description: Run P2 two-target hotfix — branch off core, cherry-pick to a deploy with auto D++ tag, merge back to core with symmetric pair trailers. Use when the user asks to hotfix, cherry-pick a fix to deploy, or do an emergency deploy fix. Also callable by other agents.
---

# cascade-hotfix

Orchestrates the two-target hotfix pattern from `cascade/docs/phase-2-hotfix.md`. Three invocations, each written and tagged by the `cascade hotfix` CLI. No LLM reasoning in the decision path — all state transitions are deterministic; halts carry structured envelopes.

**Never skip the pre-flight checks or run any write step without explicit approval from the user in this session.** The ephemeral branch is yours to discard; the cherry-pick and the core merge write refs.

## Preconditions

Verify in this order. Halt on the first failure with a concrete remediation.

1. Working tree clean: `git status --porcelain` empty. Do not auto-stash.
2. `cascade check` exits 0 (or non-errors only). If errors exist, abort — fix those first.
3. You are in a repo with `.cascade/config.yaml` and at least one `deploy/*` branch.
4. A `core` (or transitional `main`) branch exists.

## Flow — three invocations

### 1. Start

```
cascade hotfix <deploy-branch> <slug>
```

- Confirms the `<deploy-branch>` with the user (`deploy/<name>` shape). The `<slug>` is ephemeral-branch specific; short, kebab-case, no slashes.
- Creates `hotfix/<slug>` branched off core. Hands HEAD to the operator.
- Operator commits the fix with plain `git add` / `git commit`. The resulting SHA is the **pair anchor** for step 2.
- Halts: `bad-state` (slug invalid, deploy branch missing, hotfix branch name taken). Remediation is in the envelope.

### 2. Cherry-pick to deploy

```
cascade hotfix --cherry-pick <deploy-branch>
```

- Cherry-picks the ephemeral's tip onto `<deploy-branch>`, writes `Cascade-Hotfix-Pair: <ephemeral-sha>` into the cherry-picked commit, then runs `cascade tag <deploy>` internally (a pure `D++` — the cherry-pick advances no upstream prefix). Operator does not tag separately.
- Halts:
  - `merge-conflict` with `details.operation: "cherry-pick"` — operator resolves in the worktree, `git add`, `git cherry-pick --continue`, then re-invokes this skill. Do not auto-resolve.
  - `tag-version-mismatch` — local deploy tag collides with the predicted one. Operator deletes the stale tag or bumps past it.
  - `no-prior-tag` — deploy has no prior tag; operator seeds with `cascade tag <deploy> --seed <A.B.C.D>` first.

### 3. Continue — merge back to core

```
cascade hotfix --continue <handle>
```

- `<handle>` is either the ephemeral SHA or the branch name `hotfix/<slug>`. Both forms work.
- Re-derives the deploy-side cherry-pick SHA at invocation time by scanning every local `deploy/*` tip's first-parent history (window: `hotfix_loop_warn_days × 2` days) for a commit carrying `Cascade-Hotfix-Pair: <ephemeral-sha>`. This correctly picks up a commit amended between step 2 and step 3.
- Merges the ephemeral into core (history-preserving, `--no-ff`), then writes the reverse trailer `Cascade-Hotfix-Pair: <deploy-cherry-pick-sha>` on the merge commit.
- **Does NOT auto-tag core.** The next `cascade propagate` owns that surface; running `cascade tag core` by hand would duplicate that path.
- Halts:
  - `missing-pair` — no deploy tip carries the forward trailer yet. Run step 2 first.
  - `merge-conflict` with `details.operation: "merge"` — operator resolves, `git add`, `git commit` to finalize the merge, then re-invoke.

## Recovery (lost handle between steps)

- `git branch --list 'hotfix/*'` — the ephemeral persists by design.
- `git reflog` — if the branch was deleted, the tip is still in the reflog.
- Do **not** `git log core --grep=Cascade-Hotfix-Pair:` — the core-side merge hasn't happened yet at this point.

## Sharp edge: cherry-pick amend after `--continue`

If the operator amends the deploy cherry-pick **after** step 3 already ran, the pair goes out of sync: core's merge commit carries the pre-amend SHA in its trailer, deploy's cherry-pick is now at a different SHA, and `hotfix-loop-open` on `cascade check` will not recognise the propagated merge as closing the pair.

Amending **before** step 3 is fine — `--continue` re-derives the SHA. Amending after has no mechanical backstop; remediation is an explicit second amend on the core merge (or a follow-up commit) to re-align trailers.

Warn the user if they mention amending after step 3.

## Loop closure

Once `cascade propagate` carries the core fix back down through `core → channel/* → edition/* → deploy/<name>`, the reverse-trailer commit becomes reachable from the deploy tip. `cascade check` matches the pair and the `hotfix-loop-open` warning stops firing.

If a pair stays open past `hotfix_loop_warn_days` (default 14 days), `cascade check` emits:

```
[warning] hotfix-loop-open: deploy/<name>: cherry-pick <sha> (paired with <eph>) has no reverse-pair commit reachable from deploy/<name> tip; N day(s) elapsed
```

The legitimate-acknowledgement escape hatch is a bypass-log entry with rule `hotfix-loop-open`.

## Output expectations

Keep the user in the loop, terse:

- Start: "started `hotfix/<slug>` at `<sha>`"
- Cherry-pick: "cherry-picked <eph> onto <deploy> as <cp>" + "wrote tag <deploy>/A.B.C.D+1"
- Continue: "merged <handle> into core as <merge-sha>" + "reverse trailer points at <deploy> <cp>"
- Halt: kind + message + remediation, one line each.

## What this skill does NOT do

- **Does not call LLMs** to decide anything inside the flow. The CLI is deterministic; halts are structured.
- **Does not auto-resolve conflicts.** Cherry-pick and merge conflicts are semantic decisions.
- **Does not tag core.** `cascade propagate` owns that surface.
- **Does not push** tags or branches.
- **Does not walk downstream repos.** Source-repo only in Phase 2, Step 5.
