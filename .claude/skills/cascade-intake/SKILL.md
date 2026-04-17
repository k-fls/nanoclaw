---
name: cascade-intake
description: Run P1 upstream intake — analyze the upstream range, triage with the cascade-triage-intake agent, let the human approve a decomposition plan, then execute per-group merges with history preserved. Use when the user asks to pull upstream, intake upstream changes, or run /cascade-intake. Also callable by other agents that need to intake upstream.
---

# cascade-intake

Orchestrates the P1 process from cascade/docs/processes.md. The human (or a calling agent) approves the decomposition plan; you execute the mechanics.

**Never merge into a long-lived branch without explicit approval in this session.** The only exception is a merge the caller has already approved and asked you to execute.

## Preconditions

Before starting, verify in this order. Halt on the first failure with a concrete remediation.

1. `cascade check` exits 0 (or non-errors only). If errors exist, abort — the repo is not legible; fix those first.
2. Working tree is clean (`git status --porcelain` empty).
3. Current branch is `core` (or `main` per the Phase 0 transition). If on another branch, ask the user to switch; do not auto-checkout a long-lived branch.
4. `upstream` remote is configured and fetched. Run `git fetch upstream --tags`. If the remote is missing, stop and ask the user to add it.

## Flow

### 1. Analyze

Run `npm run cascade -- intake-analyze --json`. Capture both the JSON and a pretty print (`npm run cascade -- intake-analyze`). Show the pretty print to the user. If `rangeCount === 0`, there's nothing to intake — stop.

Also run `npm run cascade -- divergence-report` — the triage agent benefits from seeing where fls has diverged. Save the plain-text output as context for step 2.

### 2a. Inspect fls deletions (parallel to triage)

If the analyzer's `flsDeletionGroups` is non-empty, dispatch one `cascade-inspect-fls-deletion` subagent per group **in parallel**, before (or alongside) step 2b triage.

For each group, assemble the subagent input:

- `fls_deletion_commit`: `{ sha, subject, body, author_date }` — fetch via `git show -s --format='%H%n%s%n%aI%n%b' <deletionSha>`. For `deletionSha === 'unknown'`, pass subject/body as empty strings.
- `files`: for each file in the group, pack:
  - `path`
  - `base_content` — `git show <base>:<path>`
  - `upstream_tip_content` — `git show <source>:<path>`
  - `upstream_touching_commits` — `[{ sha, subject }]` from the analyzer's `upstreamTouchingCommits`, resolved with `git show -s --format=%s <sha>`
  - `port_hints` (optional) — if the deleted file exported named symbols, run a quick `rg -n 'exportedSymbol' src/` for each and pass the results. Cheap and high-signal. Skip if the file is not TypeScript/JavaScript or has no obvious exports.

Collect each subagent's JSON verdict. These feed both the triage agent (as additional context) and the final plan presentation.

### 2b. Triage

Invoke the `cascade-triage-intake` agent with:

- The analyzer JSON (full, not summarized)
- The divergence-report plain-text output
- **The fls-deletion verdicts from step 2a**, if any, so triage can raise risk on groups that touch files flagged `port-candidate` / `reintroduce-candidate` / `escalate` or appear in a `rationale-reopened` / `inconclusive` deletion group.

The agent returns a decomposition plan as JSON plus a prose summary. Show the prose summary to the user verbatim. Show the JSON plan collapsed / summarized (groups with kind, risk, count).

**If any deletion group's header is `rationale-reopened` or `inconclusive`**, surface it prominently to the user before asking for plan approval — this is the signal they are most likely to miss on a skim.

### 3. Approve

Ask the user:

- "Accept this plan?" — if yes, proceed.
- If no, collect their edits (re-group, change risk, change order) and re-invoke the triage agent with the feedback, or edit the JSON directly if the ask is mechanical.

Require an explicit yes. Silence / ambiguity → ask again.

### 4. Execute per group

For each group in `mergeOrder`, confirm with the user before merging. The confirmation format depends on the group's `attention` field from the plan.

**Confirmation format — always include:**

```
group #N <name>  (<kind>, attention=<level>, outcome=<expected>)
<functional_summary — 2–4 sentences from the plan>

tags: <comma-separated tags, up to 5; hide the rest unless --verbose>
commits: <commitCount> (<firstSha..lastSha>)

Proceed?
```

**Never include the raw file list in the confirmation prompt.** File paths belong in `--verbose` output. The reviewer is deciding based on *what changes behaviorally*, not *which files are touched*.

**Auto-proceed policy by attention level:**

- `attention: none` + `expected_outcome` is `accept` or `reject` — you MAY auto-proceed, but only if the user opted in for this intake session with `autoApprove: 'low-risk-only'`. Default (no opt-in): still ask, but make the prompt one line: `group #N <name>: <functional_summary>. Mechanical <outcome>. Proceed?`.
- `attention: light` — always ask. Show the 4-line format above.
- `attention: heavy` — always ask. Show the 4-line format above, and prepend a line: `⚠  This group needs attention: <first tag>, <second tag>`.

**For each group, once confirmed:**

1. Run `npm run cascade -- intake-upstream <lastSha> --source upstream/main -m "intake upstream: group N <name> (<firstSha..lastSha>)"`.
2. If the result status is `merged`: report the merge SHA + the group's `expected_outcome` ("outcome was: accept — matched"), move on.
3. If `noop`: skip.
4. If `conflicted`: run the per-file conflict loop, then `npm run cascade -- intake-upstream --continue -m "..."`.
5. If the actual outcome doesn't match `expected_outcome` (e.g. plan said `reject` but the merge introduced files), pause and ask the user whether to roll back — plan drift is a real signal.

After every group, run `npm run cascade -- check` and halt the entire flow on the first error. Report the failure; do not attempt the next group. Ask the user how to proceed (abort with `intake-upstream --abort`, reset, or resolve manually).

### 5. Per-file conflict loop

For each conflicted file reported by `intake-upstream`:

1. Read `.git/MERGE_HEAD`-relative context: the file itself (which contains conflict markers), the divergence-report entry for that path if any, the `git log -1 upstream/main -- <path>` subject.
2. If the conflict looks trivial (pure whitespace / obviously non-overlapping hunks / one side is a strict superset), resolve it yourself directly and `git add <path>`. Explain in one line what you did.
3. Otherwise, invoke the `cascade-resolve-conflict` agent with:
   - `path`, `conflictKind` (from `intake-upstream`'s JSON)
   - Extracted `base` / `ours` / `theirs` content for the conflicted file (use `git show :1:<path>`, `:2:<path>`, `:3:<path>`)
   - Surrounding function/block context where the conflict sits
   - The closest divergence-report entry for this path, if any
4. Show the agent's proposed resolution + rationale to the user. Require explicit approval or edits. Then write the accepted content to the file and `git add` it.
5. After all conflicts in the group are resolved, continue the merge.

**Never `git add` untouched-by-human agent output without confirmation.** The agent is proposing; the human accepts.

### 6. Close out

When all groups have merged (or the user aborts):

- Run `npm run cascade -- check` one last time.
- Run `npm run cascade -- version core` (or `main`) and report the new version.
- Report which groups merged, which were aborted, and any follow-up items the resolve-conflict agent flagged in its rationales.
- Do not push. The user decides when to push.

## Error handling

- **Merge fails mid-group with an unexpected error**: stop, run `npm run cascade -- intake-upstream --abort`, report the git error verbatim, and ask for guidance.
- **`cascade check` fails after a group merged**: the group's merge is already committed. Do not roll it back automatically; ask the user whether to `git reset --hard HEAD^` (destructive; user must confirm) or fix forward.
- **A prefix-mismatch error during merge**: this is the signal to refresh version sources first. Stop and recommend the refresh before continuing.

## What you never do in this skill

- Push to any remote.
- Force-push, reset, or rebase unless the user explicitly instructs.
- Squash-merge a group (the scripts enforce this; do not try to override).
- Skip `cascade check` between groups.
- Invoke `cascade-resolve-conflict` without surrounding code context. If context extraction fails, stop and ask.
- Merge an unapproved group. Every group requires the human's yes in this session.

## Agent-invoked mode

When another agent invokes this skill (not a human), the "approve plan" and "approve resolution" steps still require interactive confirmation by default. The calling agent may pass `autoApprove: 'low-risk-only'` to auto-accept `risk: low` groups with no conflicts; any `medium`/`high` group still requires human approval. There is no full-auto mode — P1 always has a human in the loop.

## Script reference

| Command | Purpose |
|---|---|
| `npm run cascade -- intake-analyze [--json]` | Read-only analysis + segmentation |
| `npm run cascade -- divergence-report [-v]` | fls-vs-upstream divergence view |
| `npm run cascade -- intake-upstream <sha> -m <msg>` | Execute a group merge |
| `npm run cascade -- intake-upstream --continue -m <msg>` | Finalize a merge after resolutions |
| `npm run cascade -- intake-upstream --abort` | Abort an in-progress merge |
| `npm run cascade -- check` | CI-equivalent validation |
| `npm run cascade -- version <branch>` | Read-only version report |

All commands are run from the `cascade/` sub-package directory. Run `cd cascade` first, or use `npm --prefix cascade run cascade -- <sub>`.
