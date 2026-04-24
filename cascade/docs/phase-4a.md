# Phase 4a — P3 reclassification, read-only

Scope for the read-only half of P3. Builds the classifier and its shadow-mode validation harness so Phase 4b can be gated on evidence, not hope. No mutations to any branch, ref, working tree, or sidecar file; no PR creation; no agent in the loop.

Implements [§10 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md) and the read-only surface of [P3 in processes.md](processes.md#p3--reclassification).

## Historical ground truth in this repo

Several pre-cascade relocations are already encoded in history — the human hand-factored code out of skill branches into module-shaped feature branches and merged the result back. These are the shadow-set anchors: the "proposed home" is known, because a human already chose it.

| Feature branch | Merge SHA (into `skill/group-oauth`) | Relocation |
|---|---|---|
| `feature/commands-module` | `c9fe4c1` | `src/commands.ts`, `src/commands.test.ts` → `src/commands/*` (extracted to module structure). Initial import at `b0869b3`. |
| `feature/commands-module` | `9c3669f` | Follow-up wiring in `src/index.ts`. |
| `feature/interaction-module` | `cc6df04` | `src/interaction/consumer.{ts,test.ts}`, `src/interaction/index.ts` → interaction module. |
| `feature/crypto-module` | (via `cd5fc7d` main-merge) | `src/crypto/index.ts` — crypto extracted into its own module. |

For each, the hunks that were deleted from the skill branch and re-introduced from the feature branch are known-good P3 proposals: path-ownership should resolve their new home to the matching module, and the classifier should score them `high`. If it doesn't, the signals are wrong.

Additional positive anchors — intra-skill relocations from `skill/ssh-auth` to `skill/group-oauth`. `skill/ssh-auth` branches from `skill/group-oauth` and pulls from it periodically; several commits authored on ssh-auth touched non-SSH files (generic auth machinery, commands, providers), i.e. they were authored one skill too deep. Path-ownership should propose `skill/group-oauth` as the home for their non-SSH hunks. Known cases:

| SHA | Subject | Files that should relocate |
|---|---|---|
| `991f841` | Initial SSH impl | non-SSH hunks on `src/auth/auth-interactions.ts`, `src/auth/credential-proxy.ts`, `src/auth/init.ts`, `src/auth/key-management.ts`, `src/auth/manifest.ts`, `src/auth/mitm-proxy.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`. SSH-specific files (`src/auth/ssh/*`, `container/skills/ssh/SKILL.md`, `src/commands/ssh-commands.ts`) stay. |
| `9c469c4` | Fix auth error detection with updated API | entire commit — `src/auth/guard.ts`, `src/auth/providers/claude.ts`, `container/agent-runner/src/index.ts`, `package.json` are all generic. |
| `e8cdd47` | Improved errors on borrowing | `src/auth/provision.{ts,test.ts}`, `src/commands/creds-commands.ts` — generic. |
| `7702069` | Cleanup messages | `src/auth/key-management.ts`, `src/auth/providers/claude.ts`, `src/commands/auth-commands.ts` — generic. |
| `1b69f64` | Fix | `src/container-runner.{ts,test.ts}` — generic; possibly even belongs on core rather than group-oauth. |

Negative controls — skill-local changes that should *stay* on `skill/ssh-auth`:

| SHA | Subject |
|---|---|
| `f195fbf` | Tests and minor improvements — touches `src/auth/ssh/*` and `container/skills/ssh/SKILL.md` only (plus one `src/commands/ssh-commands.ts` line). |
| `2ada9ef` | Fix ssh access (missing user) — `container/entrypoint.sh` SSH section only. |

Any proposal to relocate these is a false positive.

## Deliverables

### Scripts (`cascade/scripts/`)

- **`classify-change.ts`** — read-only. Input: source branch + `(from, to)` refs. Output: a `ClassifyReport` (proposals, signal scores, confidence tier). Determinism contract: byte-identical output for fixed `(source, from, to, core_sha, upstream_sha, ownership map sha)`. No wall-clock; stable hunk ordering by `(commit-author-date, commit-sha, file, hunk-start-line)`.
- **`shadow-run.ts`** — harness that walks a set of ranges, calls `classify-change`, compares against the ground-truth YAML under `cascade/tests/shadow/`, emits summary metrics (per-class precision, ambiguous rate, signal-disagreement rate). One-shot; does not write state.

### CLI additions

- `cascade classify <source-branch> --from <ref> --to <ref> [--json] [--ambiguous-only]`
- `cascade shadow-run [--fixture <name>] [--json]` — dev-facing; runs the full shadow set or a named fixture.

### Tests (`cascade/tests/`)

- Per-signal unit tests with synthetic fixtures (one hunk, one home, known verdict).
- Determinism test: two consecutive runs, byte-identical.
- Shadow fixture: ground-truth YAML for the four historical anchors above, checked in. `classify-change` must match the ground truth within the validation threshold.

### Docs

- **Signal spec** — this file, section below. Every heuristic's exact definition, including the numeric thresholds picked after calibration.
- **Validation threshold** — written down after the first shadow run, with the numbers that justify it. Lives in `phase-4-discrepancies.md` (to be created) so future phases see the rationale.

## Signal spec (v1)

Three signals, combined as a rule cascade. First signal that resolves a single home decides; disagreement → `ambiguous`, top-2 candidates surfaced.

### 1. Path-ownership

- Source: `ownership.ts` (Phase 0), already derives per-file owner from commit reachability into long-lived branches.
- Rule: a hunk's proposed home = the file's sole owner, iff that owner is not `core` (or `main` during transition).
- `core`-owned files fall through to signal 2.
- Unowned files (no long-lived branch contains the introducing commit) → `ambiguous` with remediation: "requires ownership decision."

### 2. Size/shape (applies on core-owned files only)

- Rule: the hunk is a *minimal integration edit* iff **all** of:
  1. Added lines ≤ `size_shape_max_added_lines` (calibration target; start at 10, tune on shadow set).
  2. All additions sit inside an existing function body; no new top-level declarations (class, interface, exported function, top-level const).
  3. No new imports to symbols not already reachable from `core`.
- If minimal-integration → proposed home is `core` (stay put).
- Otherwise → fall through to signal 3.

AST-free implementation: top-level declaration detection by regex anchored to column 0 on TS/JS; imports checked by parsing `import` statements with a line-regex. Good enough for v1; paid off by signal 3 if wrong.

### 3. Diff-vs-upstream (applies on core-owned files only)

- Source: `divergence-report.ts` (Phase 2) — lists `core..upstream/main` divergence hunks per file.
- Rule: the hunk is *divergence-maintenance* iff its added/removed line ranges intersect any divergence hunk on the same file.
- If divergence-maintenance → proposed home is `core` (this is §7 divergence work; it stays).
- Otherwise → proposed home = `core`, confidence `low` (core-owned file, not minimal, not divergence work — operator should review).

### Confidence tiers

- **`high`** — signal 1 resolves a single non-core owner, OR signal 1 lands on core AND signal 2 says minimal-integration, OR signal 3 says divergence-maintenance.
- **`low`** — core-owned file that failed both signal 2 and signal 3; proposed home is still `core` but flagged for review.
- **`ambiguous`** — file has multiple owners, is unowned, or signal outputs contradict (e.g. path-ownership says module-X, size/shape violated). Escalates with top-2 candidate homes.

## Shadow set selection

Ranges are selected by branch *class* from `.cascade/branch-classes.yaml`, not by hand-picked name patterns. For each class, pick the single most recent long-lived branch by commit count on the unique range vs. `main`:

| Class | Sample source | Range | Expected verdict distribution |
|---|---|---|---|
| skill | `skill/ssh-auth` | `main..skill/ssh-auth` | mix: SSH-local changes stay; generic-auth hunks (`991f841`, `9c469c4`, `e8cdd47`, `7702069`) should propose `skill/group-oauth`. Mixed verdicts per commit expected. |
| module | `module/cascade` | `main..module/cascade` | homogeneous; all `cascade/*` files should classify to the module |
| ephemeral (feature) | `feature/commands-module` | merge-base..tip | mostly `src/commands/*` → module-commands (once a module exists); historical relocation anchor |
| ephemeral (fix) | `fix/streaming-error-detection` | merge-base..tip | mostly core minimal-integration edits |

Ground truth is hand-labeled once per fixture and checked in. Regenerating ground truth is a deliberate human step; the shadow harness reports drift, it does not auto-update.

## Validation threshold methodology

Numbers are picked *after* the first shadow run, not guessed. The gating decision for 4b answers three questions with the shadow data in hand:

1. **High-confidence precision.** Of proposals scored `high`, what fraction match ground truth? Target starting point: ≥ 0.90.
2. **Ambiguous rate.** Of all proposals, what fraction scored `ambiguous`? If too high, v1 signals are insufficient and v2 signals pull forward from 4c. Target: ≤ 0.30.
3. **Negative-control soundness.** On `skill/ssh-auth` commits expected to stay on the skill, how often does the classifier propose relocation? Target: ≤ 0.05 false-positive rate.

Each threshold is recorded in `phase-4-discrepancies.md` with: the shadow numbers observed, the chosen threshold, and the rationale for any deviation from the starting points above. Changing the threshold later requires a re-run.

## Out of scope

- Any write. Full stop.
- The ambiguous-classification agent (4b).
- Follow-up plan storage (4b).
- v2 signals (symbol-dependency, import-graph, co-change, test-location, string-literal) — deferred to 4c.
- Cross-repo classification — 4b concern, via the Phase 2 patch-handoff contract.
- Automatic ownership decisions for unowned files — always escalates.

## Dependencies

- Phase 0 (`ownership.ts`, `branch-graph.ts`, `.cascade/branch-classes.yaml`).
- Phase 2 (`divergence-report.ts` — signal 3 consumer).

## Done criteria

- `cascade classify` runs deterministically against a real range. Two consecutive runs byte-identical.
- Shadow-set report covering the historical anchors is checked in.
- Validation thresholds ratified in `phase-4-discrepancies.md` with observed shadow numbers.
- Zero mutations in the codebase. Verified by running the script against a throwaway worktree and checking `git status` is clean.

## Risks

- **Signal calibration tempted by single data point.** The first shadow run will produce numbers that look like ground truth; they aren't. Threshold decisions get written down with reasoning, not just numbers, so a later phase can challenge them.
- **AST-free size/shape heuristic has sharp edges.** Regex-based top-level declaration detection misclassifies multi-line declarations split oddly. Accept the noise in v1; re-evaluate when v2 signals land.
- **Historical anchors may themselves be wrong.** The human who cut `feature/commands-module` chose *one* decomposition; other decompositions are plausible. Ground-truth YAML records the choice made, not "the" answer. Shadow disagreement with anchor is a discussion trigger, not an automatic classifier bug.
