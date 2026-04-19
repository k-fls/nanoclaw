# Inspection — contract for the P1 inspector subagents

Defines how `cascade-inspect-discarded` and `cascade-inspect-introduced` are invoked during `/cascade-intake`, what they consume, what they emit, and how the triage agent folds their output into the plan. Both inspectors share one I/O shape; only their reasoning frames differ.

Scope: P1 pre-merge review. The inspectors are advisory. They never mutate, never merge, never recommend HOW to integrate.

## Why two inspectors

The analyzer emits two arrays of components that need content-level judgment before triage can produce confident outcomes:

- **`discardedGroups[i]`** — components touching files the target discarded post-base. Upstream has kept modifying those files; the merge's mechanical default is to drop upstream's work. Question: "does the prior removal rationale still hold?"
- **`introducedGroups[i]`** — components touching files upstream added that the target never had. The merge's mechanical default is to silently acquire those files on the target. Question: "does the target want what upstream built?"

The reasoning frames are different enough that one prompt would be unfocused — the discarded inspector anchors on past removal rationale; the introduced inspector anchors on feature usefulness. The **I/O format is identical** so the skill, triage, tests, and aggregation treat both uniformly.

## Component grouping

The analyzer partitions the upstream range's commits into connected components via union-find over the bipartite commit ↔ file graph, seeded by commits that touch any candidate file (target-discarded or upstream-introduced). Two commits land in the same component if they share any touched file (transitively).

Consequence: a commit appears in **at most one** discarded component and **at most one** introduced component; a single commit can appear in both when its component has both discarded and introduced focus files.

See [cascade/docs/processes.md](processes.md) § P1 for where this fits in the end-to-end flow.

## Invocation

The skill dispatches inspectors **eagerly, in parallel**, before triage runs:

- For each `discardedGroups[i]`: one `cascade-inspect-discarded` call, scoped to `discardedFiles` as focus.
- For each `introducedGroups[i]`: one `cascade-inspect-introduced` call, scoped to `introducedFiles` as focus.

A single component with both discarded and introduced focus files gets **two** inspector calls — one per kind, each with its own focus subset. Commits are shared context in both; focus files are disjoint.

Verdicts are written to two files under `.cascade/.intake/<cacheKey>/`:

- `discarded-verdicts.json`
- `introduced-verdicts.json`

## Unified input envelope

```json
{
  "component_id": "<analyzer-assigned, stable across runs>",
  "inspection_kind": "discarded | introduced",
  "commits": [
    { "sha", "subject", "body", "author", "authorDate" }
  ],
  "focus_files": [
    {
      "path",
      "base_content": "<file content at merge-base; '' for introduced focus files>",
      "upstream_tip_content": "<file content at source tip>",
      "upstream_touching_commits": [{ "sha", "subject" }],
      "port_hints": "<optional: grep/symbol-search results>"
    }
  ],
  "context_files": [
    { "path", "upstream_tip_content_excerpt": "<first ~100 lines>" }
  ],
  "kind_specific_context": {
    "target_removal_commit": { "sha", "subject", "body", "author_date" },
    "target_feature_overview": "<optional digest; introduced-only; later enhancement>"
  }
}
```

`focus_files` is the inspector's focus. `context_files` exist to explain why the component's commits are bundled together (they share those files) — not to be reasoned about individually. The inspector does not issue verdicts on `context_files`.

`kind_specific_context.target_removal_commit` populated only for discarded kind; `target_feature_overview` only for introduced kind (and initially omitted — populated when the enhancement lands).

Files with size below `config.discarded_min_delta_lines` (discarded kind) or `config.introduced_min_file_lines` (introduced kind) are filtered out before reaching the inspector.

## Unified output schema

```json
{
  "component_id": "<copy from input>",
  "inspection_kind": "discarded | introduced",
  "group_header": "all-adopt | all-remove | mixed | inconclusive",
  "commit_verdicts": [
    {
      "sha": "<upstream commit sha>",
      "verdict": "adopt | remove | mixed | escalate",
      "escalation_reason": "<non-empty only when verdict = escalate>"
    }
  ],
  "feature_narratives": [
    {
      "title": "<short feature name>",
      "commits": ["<sha>", ...],
      "description": "<1–3 sentences on WHAT upstream did, no HOW>"
    }
  ]
}
```

### Verdict vocabulary

Per-commit, four values:

- **`adopt`** — upstream's work in this commit has affirmative, named value the target should retain. For `discarded`: reviewer should un-drop (port, reintroduce, etc.). For `introduced`: reviewer confirms acquisition is deliberate. Absence of a reason against is NOT a reason for — `adopt` requires a concrete positive. The inspector does NOT prescribe HOW.
- **`remove`** — upstream's work in this commit has no value the target needs, or carries a liability target shouldn't ship by default (telemetry, duplicate surface, external service dependency — see the `introduced` inspector's default-to-remove triggers). For `discarded`: the target's existing removal stands. For `introduced`: reviewer `git rm`s post-merge.
- **`mixed`** — this single commit contains both adopt-worthy and remove-worthy content, and the split is real (not lopsided). Triage handles the commit at group-level with standard mixed-group attention. This is a fact about the commit's contents, not a limit on the inspector's knowledge.
- **`escalate`** — inspector genuinely cannot produce a verdict — needs information, tools, or reviewer judgment it doesn't have. Must name exactly what is missing in `escalation_reason`. Do NOT use `escalate` as a shortcut for "this commit is mixed."

### Group-header vocabulary

Derived from `commit_verdicts` (the inspector doesn't pick it independently):

- **`all-adopt`** — every commit verdict is `adopt`.
- **`all-remove`** — every commit verdict is `remove`.
- **`mixed`** — any mixture that isn't unanimous and isn't blocked on an escalation: some commits `adopt` and some `remove`, or any commit is per-commit `mixed`.
- **`inconclusive`** — at least one commit is `escalate`.

### Feature narratives

Organized by feature, granularity at the inspector's discretion:

- One narrative may span multiple commits (a stack delivering one feature).
- Multiple narratives may partition a single commit (unrelated bundled changes).
- Narratives describe WHAT upstream did. They do NOT prescribe HOW to incorporate it.

## Rules the inspectors must follow

- **One verdict per commit.** The commit is the atomic decision unit. P1 intake cannot honor per-hunk or per-file decisions. When a commit mixes adopt-worthy and remove-worthy content: pick the dominant verdict for lopsided splits (explain the minor part in narratives) or `escalate` for balanced splits.
- **No integration mechanics.** Never say "port to X", "cherry-pick Y", "reintroduce by reverting Z", "add a test", "wire into module W". The reviewer decides HOW.
- **No per-file verdicts.** Features can be narrower or wider than files; decisions stay at the commit boundary.
- **No speculative rationale.** If `kind_specific_context.target_removal_commit.body` is empty, state "rationale not recorded" — do not invent motivations.
- **Upstream commit messages are not authoritative about the target's intent.** Upstream doesn't know what the target does or why.
- **Scope is the component, not the merge.** Whether the merge as a whole is a good idea is triage's job.

## Triage outcome mapping

Triage reads both verdict arrays and folds them into the plan. Mapping from inspection verdict to `expected_outcome` and canonical tags:

| Inspection kind | group_header | expected_outcome | Canonical tags |
|---|---|---|---|
| Discarded | `all-remove` | `reject` | `discarded-all-remove`, `clean-mechanical` (if no other attention signal) |
| Discarded | `all-adopt` | `unclear` | `discarded-all-adopt` (forces `attention: heavy`) |
| Discarded | `mixed` | `unclear` | `discarded-mixed` (forces `attention` ≥ `light`) |
| Discarded | `inconclusive` | `unclear` | `discarded-inconclusive` (forces `attention` ≥ `light`) |
| Introduced | `all-adopt` | `accept` | `introduced-all-adopt` (triage scans narrative for adopt-defeaters — telemetry / duplicate surface / external service / hardcoded key / license-restrictive — and sets `attention` accordingly: `none` for small aligned additions, `light` for substantive new features, `heavy` when a defeater is present. Never paired with `clean-mechanical`.) |
| Introduced | `all-remove` | `accept` | `introduced-all-remove` + `post-merge-cleanup` (forces `attention` ≥ `light`) |
| Introduced | `mixed` | `unclear` | `introduced-mixed` (forces `attention` ≥ `light`) |
| Introduced | `inconclusive` | `unclear` | `introduced-inconclusive` (forces `attention` ≥ `light`) |

The validator (`intake-validate.ts`) enforces the attention floors from tags. A discarded component's `all-adopt` is a **reopen** signal — the reviewer decides HOW to rescue upstream's work (port, reintroduce, rewrite); the merge itself does not do it.

Per-commit `adopt`/`remove`/`mixed`/`escalate` verdicts also give triage permission to split its own thematic groups at commit boundaries where verdicts flip, as long as the thematic grouping rule still holds. Per-commit `mixed` (an honest split within one commit) is distinct from `escalate` (inspector needs information/judgment it doesn't have); triage handles `mixed` via the standard mixed-group attention floor without extra human escalation.

## Triage's three-section output

After the plan JSON, triage emits:

1. **Plan summary** — one sentence on the range, plus a per-group table (`#idx | name | kind | attention | outcome | 1-line functional_summary`).
2. **Inspection summary** — per-kind counts (components by `group_header`, commits by verdict), escalations, top feature_narratives.
3. **Reviewer follow-up actions** — typed buckets:
   - **Adoption candidates** — components with `all-adopt` verdicts (or `mixed` with adopt-leaning commits). Driver commit + one-line narrative each.
   - **Removal candidates** — introduced components with `all-remove` (the post-merge `git rm` list); discarded components with `all-remove` (informational — the target's removal stands).
   - **Escalations** — components with `inconclusive` or per-commit `escalate` verdicts, each with the resolving action named.

No integration mechanics in any section. The reviewer decides HOW.

## Config knobs

Both thresholds live in `.cascade/config.yaml`:

- `discarded_min_delta_lines` (default 10) — upstream churn on a target-discarded path to trigger discarded-file inspection.
- `introduced_min_file_lines` (default 50) — file size of an upstream-introduced file the target never had to trigger introduced-file inspection.

Different defaults because the metrics mean different things: the discarded threshold gates *churn* (low floor catches small bugfixes); the introduced threshold gates *size* (higher floor skips trivial stubs).

## Non-goals

- Inspectors do not merge, write, or tag. The executor (`cascade intake-upstream`) handles mutation under human approval.
- Inspectors do not recommend integration mechanics. HOW is the reviewer's decision.
- Inspectors do not evaluate the merge as a whole. That's the triage agent's scope.
- Inspectors do not issue per-file or per-hunk verdicts. The commit is the atomic decision unit.

## Evolution notes

- **target_feature_overview for introduced-file inspector** (deferred enhancement): a digest of the target's current skills, modules, and recent removals. Lets the introduced-file inspector reason about overlap with existing target surface. Drop-in: no schema change.
- **Verdict vocabulary is closed.** `adopt | remove | mixed | escalate` is the stable set. Do not add `port-candidate`, `reintroduce-candidate`, `adopt-as-is` — those encoded HOW, which is the reviewer's job. `mixed` (split within one commit, triage handles) is distinct from `escalate` (inspector needs information/judgment beyond its scope).
