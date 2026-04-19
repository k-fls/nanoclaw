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

### Working state location

All working artifacts for this intake run live under `.cascade/.intake/<cacheKey>/` at the repo root, where `<cacheKey>` is the `cacheKey` field from the analyzer output. This path is gitignored. Required files:

- `.cascade/.intake/<cacheKey>/analyzer.json` — raw analyzer output
- `.cascade/.intake/<cacheKey>/divergence.txt` — divergence-report output
- `.cascade/.intake/<cacheKey>/discarded-verdicts.json` — concatenated verdicts from `cascade-inspect-discarded` (one entry per `discardedGroups[i]` component from the analyzer; these are pre-triage component verdicts, not triage-group verdicts)
- `.cascade/.intake/<cacheKey>/introduced-verdicts.json` — concatenated verdicts from `cascade-inspect-introduced` (one entry per `introducedGroups[i]` component)
- `.cascade/.intake/<cacheKey>/plan.json` — approved decomposition plan
- `.cascade/.intake/<cacheKey>/progress.json` — groups completed / in-progress / pending

**Never use `/tmp` or any path outside the repo.** Writing to `/tmp` loses intake state across worktrees, collides between parallel intakes, and hides the working set from the user.

**On successful completion of all groups**: remove `.cascade/.intake/<cacheKey>/` entirely. On abort or error: leave it — it's the resume signal.

### 1. Analyze

`mkdir -p .cascade/.intake/` (the `<cacheKey>` subdir is created after the analyzer reports one).

Run `npm run cascade -- intake-analyze --json`. Capture both the JSON and a pretty print (`npm run cascade -- intake-analyze`). Show the pretty print to the user. If `rangeCount === 0`, there's nothing to intake — stop.

Create `.cascade/.intake/<cacheKey>/` using the `cacheKey` from the JSON. Write the JSON to `.cascade/.intake/<cacheKey>/analyzer.json`.

Also run `npm run cascade -- divergence-report` and save to `.cascade/.intake/<cacheKey>/divergence.txt` — the triage agent benefits from seeing where the target has diverged.

### 2a. Inspect components (parallel to triage)

The analyzer emits two inspection-group arrays — `discardedGroups` and `introducedGroups`. Each entry refers to a component: a connected sub-graph of upstream-range commits that share any touched file. A single component can feed **both** a discarded component and an introduced component (different focus files, shared commits); dispatch happens per (component, inspector) pair.

Dispatch in parallel before (or alongside) step 2b triage:

- For each `discardedGroups[i]`: dispatch `cascade-inspect-discarded` with the component's commits as context and `discardedFiles` as focus.
- For each `introducedGroups[i]`: dispatch `cascade-inspect-introduced` with the component's commits as context and `introducedFiles` as focus.

Input assembly (both inspectors share the shape; see [cascade/docs/inspection.md](../../cascade/docs/inspection.md) for the full contract):

- `component_id`, `inspection_kind` ("discarded" or "introduced") — straight from the analyzer entry.
- `commits`: for each sha in `component.commits`, fetch `{ sha, subject, body, author, authorDate }` via `git show -s --format='%H%n%s%n%an%n%aI%n%b' <sha>`.
- `focus_files`: for each focus file (discarded kind: `discardedFiles`; introduced kind: `introducedFiles`), pack:
  - `path`
  - `base_content` — `git show <base>:<path>`; pass `""` when `git show` exits non-zero (path did not exist at base — normal for introduced focus files).
  - `upstream_tip_content` — `git show <source>:<path>`.
  - `upstream_touching_commits` — `[{ sha, subject }]` from the analyzer's `upstreamTouchingCommits`, each resolved with `git show -s --format=%s <sha>`.
  - `port_hints` (optional) — for files exporting named symbols, run `rg -n 'exportedSymbol' src/` and pass results. Skip for non-TS/JS files or files without obvious exports.
- `context_files`: for each path in `component.allTouchedFiles` not in `focus_files`, pack `{ path, upstream_tip_content_excerpt }`. Excerpt = first ~100 lines of `git show <source>:<path>` (truncate larger files).
- `kind_specific_context`:
  - Discarded: `{ target_removal_commit: { sha, subject, body, author_date } }` fetched via `git show -s --format='%H%n%s%n%aI%n%b' <discardedFiles[0].removalSha>`. All files in a discarded component share the component's removal context only loosely — pass the context for the dominant removal commit (the one anchoring the most files). For `removalSha === "unknown"`, pass all fields as empty strings.
  - Introduced: `{ target_feature_overview }` — optional; when present, a short digest of the target's current skills, modules, and recent removals. Initially empty/omitted; populated as a later enhancement.

Collect each subagent's JSON verdict into the appropriate array:

- Discarded verdicts → `.cascade/.intake/<cacheKey>/discarded-verdicts.json`
- Introduced verdicts → `.cascade/.intake/<cacheKey>/introduced-verdicts.json`

Both feed the triage agent (as additional context) and the final plan presentation.

### 2b. Triage

Run `cascade triage` — it reads the agent prompt at `.claude/agents/cascade-triage-intake.md`, emits a plan with decode-time schema enforcement, enriches derived fields, validates, and retries on violations internally. The output is always a valid plan or an error.

```
npm run cascade -- triage \
  --analyzer .cascade/.intake/<cacheKey>/analyzer.json \
  --divergence .cascade/.intake/<cacheKey>/divergence.txt \
  --discarded-verdicts .cascade/.intake/<cacheKey>/discarded-verdicts.json \
  --introduced-verdicts .cascade/.intake/<cacheKey>/introduced-verdicts.json \
  --out .cascade/.intake/<cacheKey>/plan.json
```

Omit either `--discarded-verdicts` or `--introduced-verdicts` (or both) when step 2a produced no inspector output for that kind. Omit `--divergence` only when the divergence report was skipped.

**Exit 0**: a valid plan is at `plan.json`; proceed to step 3.

**Non-zero exit**: the agent couldn't produce a valid plan after retries. Surface the stderr output (which contains the final validator violations) to the user and ask how to proceed — manual editing, re-running with `--max-retries <higher>`, or aborting. Never show a failed plan to the user as if it were valid.

### 3. Approve

Show the prose summary to the user verbatim. Show the JSON plan collapsed / summarized (groups with kind, attention, outcome, commitCount).

**If any inspection verdict's `group_header` is `mixed` or `inconclusive`, or any introduced-kind verdict is `all-remove`, or any discarded-kind verdict is `all-adopt`**, surface these prominently to the user before asking for plan approval — they're the signals most likely to miss on a skim. `all-adopt` on a discarded component means the reviewer should consider reopening the target's removal; `all-remove` on an introduced component means the reviewer should plan post-merge `git rm`.

Ask the user:

- "Accept this plan?" — if yes, proceed.
- If no, collect their edits (re-group, change attention, change order) and re-invoke the triage agent with the feedback, or edit the JSON directly if the ask is mechanical. Re-run `cascade intake-validate` after any edit.

Require an explicit yes. Silence / ambiguity → ask again.

### 4. Execute per group

For each group in `groups` order (they're already sorted by first-commit analyzer position), confirm with the user before merging. The confirmation format depends on the group's `attention` field from the plan.

**Confirmation format — always include:**

```
group #N <name>  (<kind>, attention=<level>, outcome=<expected>)
<functional_summary — 2–4 sentences from the plan>

grouped because: <grouping_rationale — one sentence on the shared theme>
tags: <comma-separated tags, up to 5; hide the rest unless --verbose>
commits: <commitCount> (<firstSha..lastSha>)

Proceed?
```

**Never include the raw file list in the confirmation prompt.** File paths belong in `--verbose` output. The reviewer is deciding based on *what changes behaviorally*, not *which files are touched*.

**The "grouped because" line is mandatory.** It tells the reviewer why these commits were merged into a single decision unit. If the `grouping_rationale` strains to explain the shared theme (contains "and" joining unrelated subsystems, e.g. "rename docs AND bump SDK AND tweak db formatting"), that's a signal the triage agent under-split. Stop, report this to the user, and ask whether to request re-triage with the grouping split.

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
- **On full success only**: remove `.cascade/.intake/<cacheKey>/`. The working state is no longer useful and leaving it around risks confusing the next intake.
- **On abort or error**: leave the working state in place. Update `progress.json` to record where the flow stopped; the next invocation can resume from there.
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
| `npm run cascade -- intake-analyze [--json]` | Read-only analysis (per-commit signals, divergence, conflicts, discarded + introduced components) |
| `npm run cascade -- divergence-report [-v]` | target-vs-upstream divergence view |
| `npm run cascade -- intake-validate <analyzer.json> <plan.json>` | Gate between triage and human approval |
| `npm run cascade -- intake-upstream <sha> -m <msg>` | Execute a group merge |
| `npm run cascade -- intake-upstream --continue -m <msg>` | Finalize a merge after resolutions |
| `npm run cascade -- intake-upstream --abort` | Abort an in-progress merge |
| `npm run cascade -- check` | CI-equivalent validation |
| `npm run cascade -- version <branch>` | Read-only version report |

All commands are run from the `cascade/` sub-package directory. Run `cd cascade` first, or use `npm --prefix cascade run cascade -- <sub>`.
