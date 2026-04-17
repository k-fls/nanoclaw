# Phase 0 — foundations

Scope for the first implementation pass. No process commands yet; just make the repo legible under the model and fail CI on violations.

## Deliverables

### Registry and config

- `.cascade/branch-classes.yaml` — written per the schema in [artifacts.md](artifacts.md)
- `.cascade/config.yaml` — `version_depth: 3`, upstream remote/branch
- `.cascade/ownership_rules` — seeded with the obvious patterns (`node_modules/`, lockfiles, `dist/`, generated files)
- `.cascade/bypass-log` — empty file, ready to append

### Scripts (`cascade/scripts/`)

- **`branch-graph.ts`** — classify local and remote branches against the registry; expose `classOf`, `parentOf`, `versionSourceOf`, `ancestorsOf`. Foundation for everything else.
- **`ownership.ts`** — derive owner per file per [ownership.md](ownership.md); produce `/.ownership_map.txt`; `--verify` mode reruns derivation and compares output byte-for-byte.
- **`merge-preserve.ts`** — wrapper around `git merge` enforcing §5: reject `--squash` and fast-forward into long-lived branches. Single entry point for all future P1/P2/P3 merges.
- **`version.ts`** — **read-only in Phase 0** (reports the current derived version for any branch; does not mutate). Full auto-bump logic lands in Phase 2.
- **`check.ts`** — CI entry point. Runs all of:
  - ownership determinism (rerun matches previous output)
  - every `ownership_rules` pattern matches at least one file
  - no squash or fast-forward merge commits on long-lived branches
  - no branch exists off an invalid base per the registry
  - no file has two independent introductions (§9 double-introduction error)
  - `bypass-log` format valid; all referenced commits exist
- **`bypass.ts`** — append an entry to `.cascade/bypass-log` with validation.

### CI wiring

- `check.ts` runs on every PR targeting a long-lived branch.
- Failure blocks merge.
- `bypass-log` entries suppress warnings on listed commits (does not suppress new violations).

## Out of scope for Phase 0

| Phase | Deliverable |
|---|---|
| 1 | P1 intake automation, `intake-analyze.ts` + mechanical segmentation, `cascade-triage-intake` + `cascade-resolve-conflict` agents, inline-divergence-comment conventions |
| 2 | Auto-bump version logic, P2 propagation, edition snapshots, cross-repo tooling |
| 3 | Adapter-model formalization, adapter coverage reporting |
| 4 | P3 signals (path-ownership + size/shape + diff-vs-upstream) in shadow mode; `cascade-classify-ambiguous` agent; mutating half |
| 5 | P4 divergence review tooling; P5 upstream candidates |

## Done criteria for Phase 0

- `cascade check` exits 0 on a clean repo.
- `cascade check` is runnable locally by contributors as pre-flight (not CI-only).
- Introducing a squash merge into `core` causes `cascade check` to fail.
- A branch cut from an invalid base per the registry (e.g., `module/foo` off `edition/starter`) causes `cascade check` to fail with a base-validity error.
- `/.ownership_map.txt` regenerates identically across runs (determinism).
- The prefix-mismatch rule is exercised by a `check.ts` self-test fixture (synthetic branches with disagreeing prefixes + no `parent_branch` → error). Validates the rule without waiting for real editions.
- `cascade version <branch>` correctly reports the derived 4-part version for every existing long-lived branch.

## Local pre-flight

`cascade check` runs locally, not only in CI. Contributors run it before push to catch violations early; CI runs it as the authoritative gate. An optional `pre-push` hook sample ships at `cascade/hooks/pre-push.sample`; installation is opt-in (symlink or copy into `.git/hooks/pre-push`) to respect existing hook setups.

## Transition

The repo's current default branch is `main`, not `core`. §2 forbids a `main` distinct from `core`, but a rename is invasive. Phase 0 handles this by extending the `core` pattern to recognize both:

```yaml
- name: core
  pattern: '^(core|main)$'
  base: upstream/main
  version_source: upstream/main
```

A real rename is deferred to a later phase when other large branch operations are already landing.

Existing pre-registry branches (`feature/crypto-module`, `feature/interaction-module`) match the ephemeral fallback. Files they introduced that now live on `main`/`core` via their merge commits are owned per the normal rule: first long-lived branch whose ancestry contains the introducing commit. Ephemerals are never candidate owners themselves. No data migration required.

## Open decisions to make before Phase 1

- **P1 conflict-resolution agent prompt.** What context does it need? Three-way diff is obvious; nearby inline comments yes; relevant tests? surrounding imports? To be scoped in Phase 1 kickoff.
- **Inline divergence comments (optional).** If we decide to recommend a comment grammar for non-obvious divergences, define it in Phase 1. Otherwise skip and rely on `git diff core..upstream/main` + P4 review.

## Open decisions to make before Phase 2

- **Cross-repo write path default.** Patch handoff vs. forge API. Current lean: patch handoff as default; forge API opt-in per deployment.
- **Edition snapshot delivery.** Where does `/.edition-snapshot.json` get shipped? Release artifact? Tagged commit? Decide before building the cross-repo P3 path.

## Open decisions to make before Phase 4

- **P3 shadow-mode validation.** Run `classify-change.ts` over recent deploy-branch ranges and manually validate proposal quality before enabling the mutating half. Threshold for "good enough": to be decided based on the shadow-mode results.
- **Symbol-dependency signal scope.** v2 signal. TypeScript via ts-morph is tractable. Shell/YAML/Markdown fall back to path-ownership + escalation.

## Implementation notes

- `cascade/scripts/` uses the project's existing Node/TS stack. Imports need `.js` extensions (`"type": "module"` in `package.json`).
- `branch-classes.yaml` is loaded once per script invocation; treat as immutable during a run.
- Default output is human-readable with remediation hints (sample: "file has two independent introductions on branches X and Y; rebase one onto the other, or rename one path"). `--json` flag produces machine-readable output for slash commands.
- Exit codes:

  | Code | Meaning |
  |---|---|
  | 0 | clean, or only bypassed violations |
  | 1 | at least one non-bypassed violation |
  | 2 | warnings only (returned only with `--strict`) |
