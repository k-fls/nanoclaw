# Phase 2 — P2 downstream propagation + auto-versioning

Scope for the second implementation pass. Completes the version system and lands propagation. Implements [§11 P2 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md). Depends on Phase 0 (foundations) and benefits from Phase 1 already feeding upstream changes in; runs independently of it otherwise.

**Doctrine: P2 has no LLM in the loop.** Plans are deterministic, halts emit structured envelopes, remediations live in the halt registry. An agent may *orchestrate* by invoking the CLI and reading envelopes — that is not "in the loop" in the requirements-doc §11 sense. Any design pressure to put LLM reasoning inside a P2 decision path is a signal to revisit, not a shortcut to take.

Surface contracts that Phase 2 depends on are specified in [artifacts.md](artifacts.md): [Tag body schema](artifacts.md#tag-body-schema), [Halt envelope schema](artifacts.md#halt-envelope-schema), [Halt registry](artifacts.md#halt-registry), and [Edition snapshot](artifacts.md#edition-snapshot-embedded-in-tag-body) (with schema-versioning rules).

## Deliverables

### Scripts (`cascade/scripts/`)

#### `version.ts`

Upgraded from Phase 0's read-only reporter to a **mutating** bumper/tagger. Implements the D-bump rules in [versioning.md](versioning.md):

- Reads the branch's last tag and the version source's last tag at that point.
- Compares prefix and D against the source's current tag.
- `prefix advanced` → `D = 1`, write tag `<branch>/<A.B.C.1>`.
- `D advanced, same prefix` → `D++`, write tag.
- `unchanged` → no-op.
- **First-bump baseline.** When the target branch has no prior `<branch>/*` tag, baseline is computed by walking the version source's tag history back to the merge-base between target and source: the source's tag at that merge-base is the implied prior prefix, and `D = 0` is the implied prior counter. The rule is general — "source" resolves per [versioning.md § Version sources](versioning.md) for the target's class. **Invariant:** a first-bump prefix can never exceed the source's tag at the merge-base. The three per-class phrasings below differ in *how they resolve the anchor tag* (exact match on merge-base vs. nearest ancestor tag), not in whether the result can lead the source — it cannot. Concretely:
  - `core`: source is `upstream/main`; first bump walks `upstream/main`'s tags back to the last `upstream/main → core` merge-base. Common on the first post-Phase-2 bump of `core`, which has been accumulating Phase 1 merges untagged. The resulting prefix intentionally reflects upstream at the merge-base, not upstream's current tip — if upstream has tagged since, the first `core/A.B.C.1` will look "behind"; the next `cascade propagate` advances it.
  - `edition/<new>`: source is `core` (or whatever `parent_branch` declares); first bump finds the most recent `core/*` tag reachable from (ancestor of) the `core ← edition/<new>` merge-base. No such tag reachable raises `source-tag-missing` — seed with `cascade tag edition/<new> --seed <A.B.C.D>`.
  - `module/*`, `channel/*`, `skill/*`, adapters: same rule against their declared source.
  Fully deterministic; no `0.0.0.0` synthetic tags.
- All tag writes go through `writeTag()` — see [artifacts.md § Tag body schema](artifacts.md#tag-body-schema) for the interface, body template, and refuse-to-overwrite contract.
- `versionSourceOf` on an ephemeral: returns `null`; callers get an actionable error rather than a derived guess. This resolution replaces the deferred contract in [artifacts.md § Ephemeral contract](artifacts.md#ephemeral-contract); Phase 2 updates artifacts.md in the same commit that lands the script.

Ships a library-internal 4-tuple comparator used by `check.ts` (`tag-monotonicity`) and `propagate.ts` (plan prediction). No semver library.

#### `cascade tag`

`cascade tag <branch> [-m <notes>] [--seed <A.B.C.D>]` — explicit release (`D++`, tag) for the cases `cascade propagate` can't cover. Refuses on ephemeral branches. `-m` sets human release notes that sit above the snapshot fence.

Realistic use cases — all narrow; propagate handles the common path:

- **Seeding a new branch.** First tag on a freshly-created long-lived branch where no baseline is derivable; requires `--seed`.
- **Direct commit on a long-lived branch** that is not a merge from a propagation source (e.g. a maintenance commit on `channel/telegram` authored there, not inherited via `core → channel/telegram`). Rare by design — the branch model discourages it — but the tag surface needs to exist when it happens.
- **Edition without `parent_branch`.** An edition that declares multiple sources and no explicit parent falls outside propagate's prefix-agreement guard; operators tag manually after verifying sources agree.

**Process smell, not loophole.** Using `cascade tag` on a branch that `cascade propagate` would have tagged anyway is not a loophole — the tag content (prefix + D computation, body schema, refuse-to-overwrite) is identical. It is, however, a smell: an operator is hand-advancing something that would have advanced itself on the next propagate. No mechanical block; reviewers should notice.

- **Prefix inheritance.** `A.B.C` comes from the branch's last tag. If the branch has no prior tag and no resolvable version source, the command halts with `no-prior-tag` and requires `--seed`.
- **`--seed <A.B.C.D>`.** No-baseline escape hatch. Accepted precisely when the normal rules would otherwise raise `no-prior-tag` or `source-tag-missing` — i.e. when no baseline can be computed from tags visible to the invocation. Rejected with `seed-rejected` when a baseline *is* computable (prior `<branch>/*` tag exists, or source is resolvable *and* its tags reach the merge-base). "Source resolves but has no reachable tag" is a valid `--seed` case, not a `seed-rejected` case; the flag is the remediation for `source-tag-missing`. Rejection is strict even when the supplied value matches derivation — see [§ Accepted sharp edges](#accepted-sharp-edges) for the rationale.
- **Edition targets.** `cascade tag edition/<name>` runs the same prefix-match check `propagate.ts` does before tagging; disagreeing sources + no `parent_branch` → `prefix-mismatch`, no snapshot written. On pass, computes the snapshot against **HEAD of the edition at tag time** via `edition-snapshot.ts` and embeds via `writeTag()`. No command path writes an edition tag without a snapshot block.

#### `propagate.ts`

Computes and executes the merge sequence per [versioning.md § Propagation order](versioning.md). Idempotent by construction (see [§ Execution loop](#execution-loop)).

- **Pre-flight setup, then refusal checks.** Pre-flight runs in this fixed order: (1) fetch (unless `--no-fetch`) — source-mode invocations `git fetch <upstream_remote> --tags` (from `.cascade/config.yaml`, default `upstream`), downstream-mode invocations `git fetch <downstream.source_remote> --tags`, which may raise `remote-missing` or `fetch-failed`; (2) worktree cleanliness — may raise `bad-state` or `stale-merge`. Fetch-layer refusals come first so a misconfigured remote surfaces before a dirty worktree masks it.
- `cascade propagate --dry-run` — plan output: ordered list of `(source → target)` hops with per-hop status (`done` | `pending` | `would-halt:<kind>`), predicted prefix at each target, predicted D-bump, and a `blocked_by` field per pending hop (see [artifacts.md § Halt envelope schema](artifacts.md#halt-envelope-schema)). JSON with `--json`.
- `cascade propagate` — execute. Walks the plan; for each hop inspects target state and either skips (already done), completes (merge + tag), or halts with a structured envelope. No flags for scope — the plan is the plan.
- `--no-fetch` — skip the pre-flight fetch step. Plan computes against the local ref set. Intended for offline runs and CI fixtures. Halt-registry remediations mention `--no-fetch` where relevant; registry is the single source of truth.
- `--after <branch>` — session-scoped skip. Execution begins after the hop whose target is `<branch>`. See [§ Session-scoped skip](#session-scoped-skip).
- Plan order puts `core → <target>` before any other `<source> → <target>` hop for the same target, so the target's prefix advances before sibling merges land on it. Refresh is just the first hop into the target.
- Sibling tiebreaker: among hops with the same target and neither being `core`, plan order is **lexicographic by source branch name**.

#### `edition-snapshot.ts`

Computes the snapshot object in-memory per the schema in [artifacts.md § Edition snapshot](artifacts.md#edition-snapshot-embedded-in-tag-body). Called by `propagate.ts` and by `cascade tag` on `edition/*` targets; the result is passed to `writeTag()` for embedding in the annotated-tag body. Nothing is written to the working tree.

#### `cascade snapshot`

`cascade snapshot <tag>` — prints the JSON between `---cascade-snapshot---` fences in the tag body. Refuses with `not-an-edition-tag` on a tag that carries no snapshot fence (non-edition tags by design, or a malformed edition tag that CI's tag-body validator missed). Non-edition tags never have snapshots because only `writeTag()` on `edition/*` targets emits the fence block; the refusal catches operator confusion, not a valid mode.

#### `hotfix.ts`

Shepherds the two-target hotfix pattern through three CLI invocations. Full flow at [phase-2-hotfix.md](phase-2-hotfix.md). Backstop against a forgotten final step is the `hotfix-loop-open` check (default 14 days, via `hotfix_loop_warn_days`).

#### `check.ts` (extended)

New/upgraded rules (entries with full rationale, scope, and remediation live in [artifacts.md § Halt registry](artifacts.md#halt-registry); Phase 2 adds them in the same commit as `check.ts`):

| Rule | Severity | What it checks |
|---|---|---|
| `prefix-mismatch` | halt | Merge-commit sources disagree on `A.B.C` with no `parent_branch`. Promoted from Phase 0 fixture enforcement to real enforcement on every merge commit on a long-lived branch. |
| `tag-monotonicity` | halt | A branch's tag sequence is monotonic under the 4-tuple order. Scope is tags visible to the ref set — see [§ Accepted sharp edges](#accepted-sharp-edges) for the local-vs-CI divergence. |
| `tag-naming` | halt | Tag format is `<branch>/<A.B.C.D>` only. |
| `hotfix-loop-open` | warning | Cherry-pick on `deploy/<name>` carrying `Cascade-Hotfix-Pair:` has no reverse-trailer merge commit reachable from the deploy tip within `hotfix_loop_warn_days` (default 14). Grep scope capped at `warn_days × 2`. |
| `seed-consistency` | warning | Branch's oldest tag is seed-originated and its `A.B.C` doesn't match the source's tag at the seeded commit's merge-base. Fires on every `cascade check` run. Bypass via `bypass-log` if divergence is intentional. |

### CLI additions

Index of the Phase 2 surface on the `cascade` dispatcher. Full signatures and behavior live in the per-script sections above; this is an index, not a second spec.

| Command | Section | Mutates? |
|---|---|---|
| `cascade version <branch>` | unchanged from Phase 0 (read-only reporter) | no |
| `cascade tag <branch> [-m <notes>] [--seed <A.B.C.D>]` | [§ `cascade tag`](#cascade-tag) | yes (tag) |
| `cascade propagate [--dry-run] [--json] [--no-fetch] [--after <branch>]` | [§ `propagate.ts`](#propagatets) | yes (merge + tag), except `--dry-run` |
| `cascade snapshot <tag>` | [§ `cascade snapshot`](#cascade-snapshot) | no |
| `cascade hotfix <deploy-branch> <slug> \| --cherry-pick <deploy-branch> \| --continue <handle>` | [§ Hotfix flow](#hotfix-flow) | yes (commit + trailer + tag) |

### Slash commands

- **`.claude/commands/cascade-propagate.md`** — orchestrates dry-run → confirmation → execution → summary. Instructs the driving agent to default to plain `cascade propagate` and to use `--after` only on deliberate in-session skips.
- **`.claude/commands/cascade-hotfix.md`** — orchestrates the two-target flow.

Placement is deliberate: Phase 1 ships its orchestration as a skill (`.claude/skills/cascade-intake/`) because the flow includes LLM-drafted triage + per-conflict resolution subagents that need skill-local prompts and tool scopes. P2 has no LLM reasoning in any step — plans are deterministic, halts have structured envelopes, remediations live in the halt registry — so plain slash commands are sufficient. If a later phase adds LLM steps to P2, upgrade to a skill then.

### Config additions

`.cascade/config.yaml` gains flat keys (no `propagation:` subtree — only two keys, nesting adds nothing):

```yaml
hotfix_loop_warn_days: 14
downstream:
  source_remote: source       # name of the git remote pointing at the upstream cascade repo
```

`downstream:` is present only in downstream-repo configs; source-repo configs omit it. **The presence of `downstream.source_remote` is the canonical "this repo is a downstream" signal** — no separate `repo_role` field. At load time, if `downstream.source_remote` is set and the local branch set (local refs only) contains any `channel/*`, `skill/*`, `module/*`, or `edition/*` branch, `loadConfig()` raises `role-conflict` and refuses to run. Those four classes are source-repo-exclusive; `core`/`main` are excluded from the signature (every git repo has a default branch).

Config nesting: `hotfix_loop_warn_days` is flat because it's a single knob with no natural group. `downstream:` nests despite having one key today because it's a **role marker** — future downstream-only keys (e.g. fetch cadence, deploy-branch filters) go under the same subtree rather than bloating the top level with prefix-named flat keys.

`version.ts`'s `loadConfig()` validates all keys with the same zod schema used for existing keys; unknown keys fail loud. `downstream.source_remote` is typed as a single git-remote-name string matched against `^[A-Za-z0-9][A-Za-z0-9._-]*$` — catches accidents like `"source,other"` or whitespace injections at load time rather than at fetch time.

## Execution loop

`cascade propagate` is idempotent: re-running it from any state advances the graph without retraversing already-completed hops. No cascade-owned run-state file — recovery info lives in git's own index (`MERGE_HEAD`, unmerged paths) and in tags. No `--resume`. "Where are we" is derivable from the branch graph + tags.

After pre-flight setup (fetch, unless `--no-fetch`) and pre-flight refusal checks, for each hop `(source → target)` in deterministic plan order:

1. **Inspect target state.**
   - Target has the predicted `<branch>/<A.B.C.D>` tag → `done`, skip.
   - Target has the merge commit but no tag → `partial`, write the tag via `writeTag()`, then `done`. Covers process-killed-between-merge-and-tag.
   - Target has a tag on the merge commit whose version doesn't match the re-planned prediction → halt with `tag-version-mismatch`. Never double-tag the same commit. Step-1's inspect-time check is the primary exit and fires first under all normal flows — `writeTag()` is only reached on a legitimately fresh merge commit. Its refuse-to-overwrite is an independent backstop for the pathological case where a race or direct `git tag` write lands a tag between inspect and write (see [artifacts.md § Tag body schema](artifacts.md#tag-body-schema) for named threats).
   - `MERGE_HEAD` present and **reachable from the current source tip** (`git merge-base --is-ancestor MERGE_HEAD <source>`) → halt with `merge-in-progress` (the common case: prior run conflicted on this exact hop, operator resolving; fetch between runs may have advanced the source, but `MERGE_HEAD` is still an ancestor).
   - `MERGE_HEAD` present but **not** an ancestor of the current source → halt with `stale-merge` (the merge was started from an unrelated branch or from a plan that no longer applies). Pre-flight would have caught this earlier; the mid-run check is a second line.
   - Otherwise → `pending`, continue.
2. **Execute pending hop.** `merge-preserve.ts` merges; on success, `writeTag()` tags. No-op merge (empty tree diff) = `done` with no tag write.
3. **On conflict during merge.** Halt with `merge-conflict`. Agent resolves + commits; re-run picks up in `partial` state and tags.
4. **On other halt kinds.** Halt with the structured envelope, stop the run. Topologically-dependent hops stay `pending`; sibling hops further down the plan are also not attempted this invocation — see [§ Accepted sharp edges](#accepted-sharp-edges) for the fail-fast rationale and revisit trigger.

Halt envelope shape: [artifacts.md § Halt envelope schema](artifacts.md#halt-envelope-schema). Full closed set of halt kinds: [artifacts.md § Halt registry](artifacts.md#halt-registry).

### Success output

On a clean multi-hop run, `cascade propagate` exits 0 and emits:

- **Default (human).** One line per hop that advanced, plus one summary line:
  ```
  ✓ upstream -> core                    wrote core/1.9.1.0
  ✓ core -> channel/telegram            wrote channel/telegram/1.9.1.1
  ✓ core -> channel/whatsapp            wrote channel/whatsapp/1.9.1.1
  ✓ channel/telegram -> edition/starter wrote edition/starter/1.9.1.1
  ✓ edition/starter -> deploy/prod-acme wrote deploy/prod-acme/1.9.1.1
  5 hops advanced, 0 halted, 0 no-op
  ```
  No-op hops (target already at predicted tag — the `done` path in the execution loop where no merge/tag write happens) are silent; only the summary count reflects them. Per-hop detail is available via `--dry-run --json`.
- **`--json`.** An envelope symmetric to the halt envelope:
  ```json
  {
    "halted": null,
    "progress": {
      "done": ["upstream -> core", "core -> channel/telegram", "..."],
      "pending": []
    },
    "tags_written": [
      { "branch": "core",                 "tag": "core/1.9.1.0",                 "sha": "..." },
      { "branch": "channel/telegram",     "tag": "channel/telegram/1.9.1.1",     "sha": "..." }
    ]
  }
  ```
  `halted: null` + empty `pending` is the clean-run signature. Agents consuming the CLI read `halted` first; null → all good.

## Accepted sharp edges

Behaviors that surprise first-time operators but are intentional. Symptoms only here; each cross-link points at the canonical explanation.

*Propagate.*

- **HEAD on halt.** `cascade propagate` leaves HEAD on the halted hop's target, not the pre-invocation branch. Rationale (no-worktree trade): [§ Execution loop](#execution-loop) step 1 notes; `git checkout -` to restore.
- **Fail-fast across sibling hops.** One halt stops the whole run, including topologically-independent siblings. Operators re-invoke (or use `--after`) to pick siblings up. **Revisit trigger:** ≥3 independent-chain halts in one run, or operators routinely needing `--after`. That signal means per-chain fail-fast is worth building.

*Check rules.*

- **Tag-monotonicity local vs. CI divergence.** `tag-monotonicity` reads tags visible to the invocation's ref set — local locally, origin in CI. A locally-deleted stale tag can pass locally but fail CI. Full explanation: [§ `check.ts` (extended)](#checkts-extended) `tag-monotonicity` entry.

*Tag surface.*

- **`--seed` rejected even when the value matches.** The flag is an escape hatch for "no derivable baseline," not a re-assertion tool. See [§ `cascade tag`](#cascade-tag).

*Hotfix.*

- **Cherry-pick amend after `--continue`.** Amending the deploy cherry-pick *after* step 4 desyncs the trailer pair; `hotfix-loop-open` won't close. No mechanical backstop. See [phase-2-hotfix.md § Sharp edge](phase-2-hotfix.md#sharp-edge-cherry-pick-amend-after---continue).

## Session-scoped skip

`cascade propagate --after <branch>` skips the hop whose target is `<branch>` **and every pending hop whose `blocked_by` chain traces back to it.** Independent siblings still execute. Nothing is persisted — the next plain `cascade propagate` run re-plans from scratch and re-hits the same halt unless the underlying condition has been resolved.

If `--after <branch>` is invoked when no hop is currently halted (clean run, or `<branch>` doesn't match any pending hop), the command exits with code 2 and a `after-no-match: no halted hop targeting <branch>` message on stderr. This is a **CLI usage error**, not a halt: it doesn't emit a halt envelope, isn't in the halt registry, and can't be bypass-logged. Silently treating it as a no-op would hide operator mistakes.

Ambiguity note: a target like `edition/starter` is reached by multiple hops. The fail-fast execution model guarantees only one hop is halted at any given time, so `--after <branch>` unambiguously resolves to "the currently halted hop, whose target is `<branch>`." The `--after` argument is a branch name only; there is no fuller `"core -> edition/starter"` form — the one-halt-at-a-time invariant makes it unnecessary.

`--after` is deliberately ephemeral — for "I've decided in this session that this hop needs human attention; continue with the rest." It is not a persistent acknowledgement; that goes through `cascade bypass` (Phase 0 mechanism), which suppresses future halts of the same kind at the same commit.

## Hotfix flow

Split out to a sibling file: [phase-2-hotfix.md](phase-2-hotfix.md). Covers the three-invocation flow, state transitions, `Cascade-Hotfix-Pair:` trailer mechanics, recovery, and the cherry-pick-amend sharp edge. `hotfix.ts` deliverable, CLI surface, done criteria, and the `hotfix-loop-open` risk remain in this document and cross-reference the companion.

## Execution contexts

Mechanics are identical across source and downstream repos — same plan order, same `writeTag()`, same halt registry. Deltas when running in a downstream repo (declared by `downstream.source_remote` in `.cascade/config.yaml`, default remote name `source`):

- **Fetch scope:** pre-flight fetches `<source_remote> --tags` instead of `<upstream_remote>`.
- **Merge source:** `merge-preserve.ts` merges from the remote-tracking ref (e.g. `<source_remote>/edition/<name>`) into local `deploy/<name>`; no local `edition/*` is created, preserving the `role-conflict` invariant ([§ Config additions](#config-additions)).
- **Plan scope:** limited to hops the local branch graph contains — typically just `edition/<name> → deploy/<name>`.

Single-source invariant: a downstream consumes editions from exactly one source repo. Enforced at the schema level (`downstream.source_remote` is one string); a richer ancestry check is deferred.

### cascade CLI in downstream repos

Downstream repos need the `cascade` CLI installed once, not per-run. Phase 2 path: git submodule or subtree of `cascade/` from the source repo. Max supported snapshot `schema_version` is `MAX_SNAPSHOT_SCHEMA` in `cascade/scripts/snapshot-schema.ts`. Registry publish (`npm publish`) stays deferred.

## CI wiring

- `check.ts` new rules run on every PR targeting a long-lived branch.
- On any `<branch>/<A.B.C.D>` tag push, CI re-parses the annotated body via the `writeTag()` body parser and (for editions) schema-validates the embedded snapshot.
- `propagate.ts --dry-run` runs in CI against fixture repos on any PR whose diff touches `cascade/scripts/` or `.cascade/**`. Fixtures are checked-in git bundles under `cascade/tests/fixtures/`, rebuildable via `cascade/tests/fixtures/rebuild.sh` from recipes in `recipes/<name>.sh` (recipes are authoritative; bundles are the cache). A determinism regression fails the PR. See `cascade/tests/fixtures/README.md` for regeneration workflow and the rationale for convention-over-CI enforcement.

## Working state layout

| Path | Role | Gitignored | Committed to |
|---|---|---|---|
| Annotated tag `<branch>/<A.B.C.D>` | Version + (for editions) snapshot | n/a | git tag object |
| `Cascade-Hotfix-Pair:` commit trailer | Hotfix loop closure | n/a | commit message on long-lived branch |

No new file under `.cascade/` or the working tree in Phase 2. All new persistent state is either in tags or in commit trailers.

## Out of scope for Phase 2

| Phase | Deliverable |
|---|---|
| 3 | Adapter coverage scanning, `cascade adapters`, per-adapter stubbing |
| 4 | Any P3 reclassification mechanics |
| 5 | Divergence annotation, upstream-candidate PR building |

Explicitly deferred within P2 itself:

- **Registry publish** of the `cascade` npm package. Submodule/subtree installs cover downstream repos.
- **Automatic release-notes generation.** Notes above the fence are human-written and optional.
- **Retroactive tagging of pre-Phase-2 merges.** Tags start flowing from the first post-Phase-2 `version.ts` run; prior history is accepted as-is. First-bump baseline handles the discontinuity.
- **Multi-source downstream repos.** Single-source invariant is enforced.

## Done criteria for Phase 2

**Happy path:**

- A `core` bump flows through `module/*`, `channel/*`, `skill/*`, `edition/<name>`, and `deploy/<name>` with one `cascade propagate` invocation, producing the expected tag at every hop.
- Every long-lived branch touched by propagation carries an annotated tag `<branch>/<A.B.C.D>`; lightweight tags are rejected by `writeTag()`.
- An `edition/<name>` tag's annotated body contains a parseable snapshot; `cascade snapshot edition/<name>/<version>` round-trips to the same JSON `edition-snapshot.ts` would generate locally.
- A downstream repo configured with `downstream.source_remote` runs `cascade propagate` and produces the expected `deploy/<name>` tag without additional flags.
- Hotfix happy path: see [phase-2-hotfix.md § Done criteria](phase-2-hotfix.md#done-criteria).
- Idempotent re-run: after a merge-without-tag interruption, plain `cascade propagate` detects the partial hop, writes the missing tag; the resulting graph is indistinguishable from an uninterrupted run.

**Halt matrix** (each kind exercised end-to-end):

| Kind | Trigger | Resolution | Fixture |
|---|---|---|---|
| `merge-conflict` | Synthetic conflict on a hop's merge. | Manual resolve + `git commit`; re-run picks up in `partial` and tags. | `fixtures/halt-merge-conflict/` |
| `merge-in-progress` | Re-run after a conflicted halt; `MERGE_HEAD` is still an ancestor of the source tip. | Finish or abort the merge; re-run. | same fixture as `merge-conflict`, second invocation |
| `stale-merge` | Branch-graph change makes `MERGE_HEAD` no longer an ancestor of any plan source. | `git merge --abort`; re-run. | `fixtures/halt-stale-merge/` |
| `prefix-mismatch` | Edition-merge sources disagree on `A.B.C` with no `parent_branch`. Also fires on `cascade tag edition/<name>`. | Advance sources to the same prefix, or declare `.cascade/parent_branch`. | `fixtures/halt-prefix-mismatch/` |
| `tag-version-mismatch` | Manually-written tag at a different D on the target merge commit. | Delete the stale local tag or follow-up-bump. | `fixtures/halt-tag-version-mismatch/` |
| `source-tag-missing` | Resolvable source has no tag reachable from the merge-base. | `cascade tag <branch> --seed <A.B.C.D>`. | `fixtures/halt-source-tag-missing/` |
| `no-prior-tag` | `cascade tag` on a branch with no prior tag and no resolvable source. | `--seed`. | `fixtures/halt-no-prior-tag/` |
| `fetch-failed` | Simulated network failure during pre-flight fetch. | Resolve network; re-run, or `--no-fetch`. | `fixtures/halt-fetch-failed/` |
| `unsupported-snapshot-version` | Edition tag `schema_version` exceeds CLI's `MAX_SNAPSHOT_SCHEMA`. | Update the `cascade/` submodule in the consumer repo. | `fixtures/halt-unsupported-snapshot/` |
| `role-conflict` | Repo has `downstream.source_remote` **and** a local source-composition branch. | Remove one or the other. | `fixtures/halt-role-conflict/` |

**Usage errors (exit 2, no halt envelope):**

- `after-no-match`: `cascade propagate --after foo` on a clean plan or against a non-pending target exits code 2, emits no envelope, and touches no repo state.
- `seed-rejected`: `cascade tag <branch> --seed X.Y.Z.W` on a branch with a derivable version exits with the error even when the supplied seed matches what derivation would compute.

**Determinism (fixed-state):**

- Two consecutive `cascade propagate --dry-run --json` invocations against a fixed repo state (same refs, same config, same working tree) produce byte-identical output. The dry-run envelope contains no timestamps, wall-clock values, or HEAD-at-invocation SHAs, and object-key order is stable. Scope is the **planner** output (hops, predicted prefixes, predicted D-bumps, `blocked_by`). The real-run `--json` envelope's `tags_written[].sha` field is **not** determinism-scoped — it reflects the SHA produced by the actual merge-and-tag pass and changes with every execution; determinism as a CI gate applies to `--dry-run` only. Not a network-resilience claim either: fetches between runs legitimately change the plan.
- `--after` session-scoped skip: executes only hops whose `blocked_by` chain does not include the halted hop.

**CI vs. local:**

- Tag-monotonicity regression: locally deleting a stale tag and re-tagging at a later commit passes `cascade check` locally but fails in CI (which fetches origin's tag set first). Both directions exercised; sharp-edge note at [§ Accepted sharp edges](#accepted-sharp-edges) points readers here.
- Config-schema regression: a typo under `downstream:` fails CLI startup with a clear error.

## Risks without a mechanical mitigation in spec

Risks whose mitigation is restating a spec line already covered above (auto-bump via `writeTag()`, stale-fetch via pre-flight, CLI drift via `unsupported-snapshot-version`, `--after`-as-retry via slash-command prompt, forgotten step 4 via `hotfix-loop-open`) are not repeated here. This section lists only risks with **no structural backstop in Phase 2** — the ones an operator can still walk into.

- **Wrong `--seed` anchors a mis-versioned lineage.** `--seed` is the only path that establishes a baseline where cascade can't derive one; every subsequent bump on that branch inherits from it. A typo propagates forever.
  *Partial mitigation:* `seed-consistency` warning (see §`check.ts`). Warning, not error — legitimate divergence exists. The warning surfaces the most common typo shape at the cheapest moment to fix it (before the lineage grows), but nothing blocks a bad seed from being written in the first place.

- **`--after` skip is topological, not semantic.** `--after <branch>` skips the halted hop and every pending hop whose `blocked_by` chain traces to it — a graph operation. Operators reach for `--after` when they've judged a hop needs human attention, which is a semantic statement. The two diverge: a halted `channel/telegram` that an operator means to hold for review does not block `edition/starter` if the edition's declared sources don't include telegram — the edition advances, its next snapshot reflects state the operator meant to gate, and downstreams pick up the "unreviewed" edition on the next propagate. No mechanical backstop.
  *Partial mitigation:* the operator can escalate intent via `cascade bypass` (persistent, halt-kind-scoped), but that's only appropriate if the halt reason itself is being accepted; it doesn't cover "hold this hop's content for review." Best practice is to resolve rather than `--after` when the operator's concern is content, not the halt kind.

- **Snapshot schema drift silently stalls downstreams.** If the source repo starts emitting edition tags at `schema_version=N+1` before a downstream repo updates its `cascade/` submodule (pinned at `MAX_SNAPSHOT_SCHEMA=N`), the downstream halts on every new edition tag with `unsupported-snapshot-version`. The halt is explicit per-invocation, but the aggregate effect — the downstream is frozen at the last-consumed edition until someone updates its submodule — is not monitored. No freshness alarm, no "your downstream is 5 editions behind" signal.
  *Partial mitigation:* schema bumps are additive within a major (existing consumers keep reading older fields); `unsupported-snapshot-version` refuses rather than misreads; and submodule-update is a standard PR surface. The gap is observability across repos, which Phase 2 doesn't address.

- **Partially-propagated push.** An operator halts mid-run, then pushes `done` hops before fixing the halted one. Consumers (CI, downstream repos) see a provisional graph.
  *Mitigation:* none structural in Phase 2. Best practice is "don't push until the run completes clean." A pre-push hook under `cascade/hooks/` that refuses when the most recent envelope is a halt is the future backstop — deferred, doesn't match the risk at current operator count.

- **Cherry-pick amend after `--continue`.** Covered as [§ Accepted sharp edges](#accepted-sharp-edges); listed here because it's a risk with no mechanical backstop, not an oddity of propagate.

## Local pre-flight

- `cascade version` and `cascade snapshot` are read-only.
- `cascade propagate --dry-run` is safe on a clean worktree and recommended before any real P2 run.
- `cascade tag`, `cascade propagate` (non-dry-run), and `cascade hotfix` all mutate; each prompts for confirmation before the first write.

## Open decisions to make before Phase 3

- **Adapter-coverage scan granularity.** File-level vs. symbol-level. Likely file-level for v1.
- **`cascade adapters` integration with `/add-*` skill docs.** How coverage data surfaces in channel-skill install flows.

## Open decisions to make before Phase 4

(No Phase 2 decisions gate Phase 4 beyond what Phase 0 / Phase 2 already settle. Dependency direction: Phase 4's inline-removal step gates on P2 confirmation — P3 cannot remove an inline version on the source branch until the propagated version has landed there via P2 and CI is green.)

## Implementation notes

- `version.ts` mutation is the highest-risk surface; `writeTag()` is the architectural enforcement.
- `propagate.ts` is a thin orchestrator over `merge-preserve.ts` + `version.ts` + `edition-snapshot.ts`. Avoid re-implementing merge logic; treat any merge question as a bug in `merge-preserve.ts` and fix it there.
- `Cascade-Hotfix-Pair:` trailers follow RFC 5322 key:value shape and are written via `git interpret-trailers --in-place` so they survive rebase/cherry-pick through normal git tooling.
- `artifacts.md` updates land in the same commit as the script that first writes each surface (`writeTag()` body schema + halt envelope with `version.ts`; edition snapshot with `edition-snapshot.ts`; halt registry entries with each script that raises them).

## Kickoff order

**Precondition (doc, not code):** phase-2.md lands in the same commit as the artifacts.md sections it links to — `#tag-body-schema`, `#halt-envelope-schema`, `#halt-registry`, `#edition-snapshot-embedded-in-tag-body`, `#ephemeral-contract`. This doc itself and the artifacts.md additions are siblings in one commit so no intermediate state has broken cross-references.

1. `version.ts` mutating + `writeTag()` + tag-naming + tag-monotonicity checks. Lets P1-style merges start tagging once upstream's tags are reachable (first-bump baseline needs a computable source tag; in practice upstream's tags are always fetched, but note the dependency). Validates first-bump baseline on real `core` history.
2. `edition-snapshot.ts` + `snapshot-schema.ts` (`MAX_SNAPSHOT_SCHEMA` + parser) + annotated-tag body writer/reader + CI tag-body validator.
3. `propagate.ts` dry-run planner (plan order, per-hop status, JSON output shape).
4. `propagate.ts` executor + halt envelope + `--after` + `--no-fetch` + `/cascade-propagate` slash command.
5. `hotfix.ts` + trailer-writing + `hotfix-loop-open` check + `/cascade-hotfix`.
6. Downstream-repo walkthrough: second git repo with `downstream.source_remote` configured, run `cascade propagate` end-to-end, fold findings back into the slash command.
