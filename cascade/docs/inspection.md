# Inspection — contract for the P1 inspector subagents

Defines how `cascade-inspect-fls-deletion` and `cascade-inspect-upstream-addition` are invoked during `/cascade-intake`, what they consume, what they emit, and how the triage agent folds their output into the plan. Both inspectors share one I/O shape; only their reasoning frames differ.

Scope: P1 pre-merge review. The inspectors are advisory. They never mutate, never merge, never recommend HOW to integrate.

## Why two inspectors

The analyzer emits two arrays of components that need content-level judgment before triage can produce confident outcomes:

- **`flsDeletionGroups[i]`** — components touching files fls deleted post-base. Upstream has kept modifying those files; the merge's mechanical default is to drop upstream's work. Question: "does the prior deletion rationale still hold?"
- **`upstreamAdditionGroups[i]`** — components touching files upstream added that fls never had. The merge's mechanical default is to silently acquire those files on fls. Question: "does fls want what upstream built?"

The reasoning frames are different enough that one prompt would be unfocused — deletion anchors on past rationale, addition anchors on feature usefulness. The **I/O format is identical** so the skill, triage, tests, and aggregation treat both uniformly.

## Component grouping

The analyzer partitions the upstream range's commits into connected components via union-find over the bipartite commit ↔ file graph, seeded by commits that touch any candidate file (fls-deleted or fls-added). Two commits land in the same component if they share any touched file (transitively).

Consequence: a commit appears in **at most one** deletion group and **at most one** addition group; a single commit can appear in both when its component has both deleted and added files.

See [cascade/docs/processes.md](processes.md) § P1 for where this fits in the end-to-end flow.

## Invocation

The skill dispatches inspectors **eagerly, in parallel**, before triage runs:

- For each `flsDeletionGroups[i]`: one `cascade-inspect-fls-deletion` call, scoped to `deletedFiles` as focus.
- For each `upstreamAdditionGroups[i]`: one `cascade-inspect-upstream-addition` call, scoped to `addedFiles` as focus.

A single component with both deleted and added files gets **two** inspector calls — one per kind, each with its own focus subset. Commits are shared context in both; focus files are disjoint.

Verdicts are written to two files under `.cascade/.intake/<cacheKey>/`:

- `deletion-verdicts.json`
- `addition-verdicts.json`

## Unified input envelope

```json
{
  "component_id": "<analyzer-assigned, stable across runs>",
  "inspection_kind": "deletion | addition",
  "commits": [
    { "sha", "subject", "body", "author", "authorDate" }
  ],
  "focus_files": [
    {
      "path",
      "base_content": "<file content at merge-base; '' for addition focus files>",
      "upstream_tip_content": "<file content at source tip>",
      "upstream_touching_commits": [{ "sha", "subject" }],
      "port_hints": "<optional: grep/symbol-search results>"
    }
  ],
  "context_files": [
    { "path", "upstream_tip_content_excerpt": "<first ~100 lines>" }
  ],
  "kind_specific_context": {
    "fls_deletion_commit": { "sha", "subject", "body", "author_date" },
    "fls_feature_overview": "<optional digest; addition-only; later enhancement>"
  }
}
```

`focus_files` is the inspector's focus. `context_files` exist to explain why the component's commits are bundled together (they share those files) — not to be reasoned about individually. The inspector does not issue verdicts on `context_files`.

`kind_specific_context.fls_deletion_commit` populated only for deletion kind; `fls_feature_overview` only for addition kind (and initially omitted — populated when the enhancement lands).

Files with size below `config.fls_deletion_min_delta_lines` (deletion) or `config.upstream_addition_min_file_lines` (addition) are filtered out before reaching the inspector.

## Unified output schema

```json
{
  "component_id": "<copy from input>",
  "inspection_kind": "deletion | addition",
  "group_header": "all-adopt | all-remove | mixed | inconclusive",
  "commit_verdicts": [
    {
      "sha": "<upstream commit sha>",
      "verdict": "adopt | remove | escalate",
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

Per-commit, three values only:

- **`adopt`** — upstream's work in this commit has value fls should retain. For deletion: reviewer should un-drop (port, reintroduce, etc.). For addition: reviewer confirms acquisition is deliberate. The inspector does NOT prescribe HOW.
- **`remove`** — upstream's work in this commit has no value fls needs. For deletion: existing fls deletion stands. For addition: reviewer `git rm`s post-merge.
- **`escalate`** — inspector can't decide from inputs. Must name exactly what is missing in `escalation_reason`.

### Group-header vocabulary

Derived from `commit_verdicts` (the inspector doesn't pick it independently):

- **`all-adopt`** — every commit verdict is `adopt`.
- **`all-remove`** — every commit verdict is `remove`.
- **`mixed`** — some `adopt`, some `remove`.
- **`inconclusive`** — at least one `escalate`.

### Feature narratives

Organized by feature, granularity at the inspector's discretion:

- One narrative may span multiple commits (a stack delivering one feature).
- Multiple narratives may partition a single commit (unrelated bundled changes).
- Narratives describe WHAT upstream did. They do NOT prescribe HOW to incorporate it.

## Rules the inspectors must follow

- **One verdict per commit.** The commit is the atomic decision unit. P1 intake cannot honor per-hunk or per-file decisions. When a commit mixes adopt-worthy and remove-worthy content: pick the dominant verdict for lopsided splits (explain the minor part in narratives) or `escalate` for balanced splits.
- **No integration mechanics.** Never say "port to X", "cherry-pick Y", "reintroduce by reverting Z", "add a test", "wire into module W". The reviewer decides HOW.
- **No per-file verdicts.** Features can be narrower or wider than files; decisions stay at the commit boundary.
- **No speculative rationale.** If `kind_specific_context.fls_deletion_commit.body` is empty, state "rationale not recorded" — do not invent motivations.
- **Upstream commit messages are not authoritative about fls intent.** Upstream doesn't know what fls does or why.
- **Scope is the component, not the merge.** Whether the merge as a whole is a good idea is triage's job.

## Triage outcome mapping

Triage reads both verdict arrays and folds them into the plan. Mapping from inspection verdict to `expected_outcome` and canonical tags:

| Inspection kind | group_header | expected_outcome | Canonical tags |
|---|---|---|---|
| Deletion | `all-remove` | `reject` | `deletion-all-remove`, `clean-mechanical` (if no other attention signal) |
| Deletion | `all-adopt` | `unclear` | `deletion-all-adopt` (forces `attention: heavy`) |
| Deletion | `mixed` | `unclear` | `deletion-mixed` (forces `attention` ≥ `light`) |
| Deletion | `inconclusive` | `unclear` | `deletion-inconclusive` (forces `attention` ≥ `light`) |
| Addition | `all-adopt` | `accept` | `addition-all-adopt`, `clean-mechanical` (if no other signal) |
| Addition | `all-remove` | `accept` | `addition-all-remove` + `post-merge-cleanup` (forces `attention` ≥ `light`) |
| Addition | `mixed` | `unclear` | `addition-mixed` (forces `attention` ≥ `light`) |
| Addition | `inconclusive` | `unclear` | `addition-inconclusive` (forces `attention` ≥ `light`) |

The validator (`intake-validate.ts`) enforces the attention floors from tags. A deletion component's `all-adopt` is a **reopen** signal — the reviewer decides HOW to rescue upstream's work (port, reintroduce, rewrite); the merge itself does not do it.

Per-commit `adopt`/`remove`/`escalate` verdicts also give triage permission to split its own thematic groups at commit boundaries where verdicts flip, as long as the thematic grouping rule still holds.

## Triage's three-section output

After the plan JSON, triage emits:

1. **Plan summary** — one sentence on the range, plus a per-group table (`#idx | name | kind | attention | outcome | 1-line functional_summary`).
2. **Inspection summary** — per-kind counts (components by `group_header`, commits by verdict), escalations, top feature_narratives.
3. **Reviewer follow-up actions** — typed buckets:
   - **Adoption candidates** — components with `all-adopt` verdicts (or `mixed` with adopt-leaning commits). Driver commit + one-line narrative each.
   - **Removal candidates** — addition components with `all-remove` (the post-merge `git rm` list); deletion components with `all-remove` (informational — deletion stands).
   - **Escalations** — components with `inconclusive` or per-commit `escalate` verdicts, each with the resolving action named.

No integration mechanics in any section. The reviewer decides HOW.

## Config knobs

Both thresholds live in `.cascade/config.yaml`:

- `fls_deletion_min_delta_lines` (default 10) — upstream churn on an fls-deleted path to trigger deletion inspection.
- `upstream_addition_min_file_lines` (default 50) — file size of an fls-never-had upstream addition to trigger addition inspection.

Different defaults because the metrics mean different things: deletion gates *churn* (low floor catches small bugfixes); addition gates *size* (higher floor skips trivial stubs).

## Non-goals

- Inspectors do not merge, write, or tag. The executor (`cascade intake-upstream`) handles mutation under human approval.
- Inspectors do not recommend integration mechanics. HOW is the reviewer's decision.
- Inspectors do not evaluate the merge as a whole. That's the triage agent's scope.
- Inspectors do not issue per-file or per-hunk verdicts. The commit is the atomic decision unit.

## Evolution notes

- **fls_feature_overview for addition inspector** (deferred enhancement): a digest of current fls skills, modules, and recent removals. Lets the addition inspector reason about overlap with existing fls surface. Drop-in: no schema change.
- **Verdict vocabulary is closed.** `adopt | remove | escalate` is the stable set. Do not add `port-candidate`, `reintroduce-candidate`, `adopt-as-is` — those encoded HOW, which is the reviewer's job.
