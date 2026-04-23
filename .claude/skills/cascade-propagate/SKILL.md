---
name: cascade-propagate
description: Run P2 downstream propagation — plan the merge sequence, confirm with the human, execute per-hop merges and auto-tagging, report results. Use when the user asks to propagate, cascade downstream, run cascade propagate, or requests D-bump propagation after a core tag. Also callable by other agents.
---

# cascade-propagate

Orchestrates the Phase 2 propagation flow from `cascade/docs/phase-2.md`. The human (or calling agent) approves the plan; you execute the mechanics via the `cascade propagate` CLI. No LLM reasoning inside a propagation decision path — the CLI's plan is deterministic and its halts carry structured envelopes.

**Never run `cascade propagate` without showing the dry-run first and getting explicit approval in this session.** Dry-run is cheap, writes nothing, and exposes mistakes before they touch refs.

## Preconditions

Verify in this order. Halt on the first failure with a concrete remediation.

1. Working tree clean: `git status --porcelain` empty. If dirty, ask the user to stash or commit; do not auto-stash.
2. `cascade check` exits 0 (or non-errors only). If errors exist, abort — the repo is not legible; fix those first.
3. You are running in a repo that has `.cascade/config.yaml`. If not, this is not a cascade-managed repo; stop.

## Flow

### 1. Dry-run

```
cascade propagate --dry-run --json
```

Parse the envelope. Three outcomes:

- **`halted` is null, `pending` is empty, `done` is non-empty.** Clean graph — nothing to do. Tell the user and stop.
- **`halted` is non-null.** A pre-flight refusal or a predicted halt. Show the user the halt kind + remediation from the envelope. Do NOT proceed to execution until the user resolves the underlying condition (or explicitly directs you to use `--after`).
- **`halted` is null, `pending` is non-empty.** There is work to do. Render the plan to the user in human form (run `cascade propagate --dry-run` without `--json`) and ask for approval.

### 2. Confirmation

Before running execution, summarize to the user:

- Number of hops that would advance, with the target branch and predicted tag for each.
- Any hops marked `would-halt` in the dry-run output (they indicate a predicted problem — explain what and let the user decide whether to resolve first).

Wait for explicit approval. `yes`, `go`, `ok`, or equivalent. Anything else → stop.

### 3. Execute

```
cascade propagate --json
```

Parse the result envelope:

- **Clean run (`halted: null`, `pending: []`).** Report `tags_written` to the user as a one-line-per-tag list, plus the summary count. Done.
- **Halted (`halted` is non-null).** Report the halted hop + kind + remediation. HEAD is left on the halted hop's target. The execution loop's failure modes are:
  - `merge-conflict` — user resolves in the worktree, runs `git commit`, then re-invokes this skill (or `cascade propagate` directly). Do NOT auto-resolve conflicts.
  - `merge-in-progress` — prior run conflicted here and the resolution isn't committed yet. User finishes (`git commit`) or aborts (`git merge --abort`), then re-runs.
  - `stale-merge` — `MERGE_HEAD` is from a prior plan that no longer applies. User `git merge --abort`, then re-runs.
  - `source-tag-missing` / `no-prior-tag` — user runs `cascade tag <branch> --seed <A.B.C.D>` per the remediation.
  - `tag-version-mismatch` — a local tag exists at a conflicting commit. User deletes the local tag (`git tag -d <tag>`) or bumps past it.
  - `fetch-failed` — user resolves network/credentials, or re-runs with `--no-fetch` for offline mode.
  - `unsupported-snapshot-version` (downstream only) — update the `cascade/` submodule.
  - `role-conflict` — repo has both `downstream.source_remote` configured and local source-composition branches; user removes one side.

### 4. `--after` (session skip)

Only use `--after <branch>` when the user **explicitly** says "skip that hop" or "keep going past X for now." It's an in-session concession, not a fix. The underlying halt will re-appear on the next plain `cascade propagate`.

Never propose `--after` as a first-line remediation. Resolving the halt is almost always the right call — `--after` is for "I need to review this one separately, unblock the rest."

Usage error to handle: `cascade propagate --after <branch>` exits 2 with `after-no-match` on stderr if `<branch>` isn't a currently-halted target. Tell the user the plan has no halted hop targeting that branch; re-run dry-run to see current state.

### 5. Re-run after resolution

On any halt remediation, the operator re-invokes `cascade propagate` (no special `--resume` flag exists). The execution loop is idempotent: completed hops stay completed, the halted hop picks up from partial state (merge commit without tag writes just the tag), and subsequent hops advance from there.

## Output expectations

Keep the user in the loop at each stage, but terse:

- Dry-run: render the plan table exactly as `cascade propagate --dry-run` produces it.
- Execution: one line per tag written, then the summary.
- Halt: the hop + kind + remediation, one line each.

Don't invent interpretations of the envelope. The halt registry (`cascade/docs/artifacts.md § Halt registry`) is authoritative.

## What this skill does NOT do

- **Does not call LLMs** to decide anything inside a hop. The CLI's planner is deterministic; halts are structured. Every decision is either the user's or the CLI's — never yours.
- **Does not auto-resolve conflicts.** Merge conflicts are semantic decisions.
- **Does not push tags.** Local tags only; `git push --tags` is the operator's choice.
- **Does not cross the hotfix flow.** Use the `cascade-hotfix` skill for that.
