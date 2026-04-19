# Phase 0 — foundations

Scope for the first implementation pass. No process commands yet; just make the repo legible under the model and fail CI on violations.

## Deliverables

### Registry and config

- `.cascade/branch-classes.yaml` — written per the schema in [artifacts.md](artifacts.md)
- `.cascade/config.yaml` — `version_depth: 3`, upstream remote/branch
- `.cascade/ownership_rules` — seeded with the obvious patterns, using the `?` prefix to mark safety-net entries (`?node_modules/`, `?dist/`, generated files); lockfiles bare (project-owned)
- `.cascade/ownership_overrides` — optional, ships empty; populated case-by-case when history leaves derivation ambiguous
- `.cascade/bypass-log` — seeded with `upstream/*` standing policy entries for `double-introduction` and `merge-preserve`; ready to append case-specific bypasses

### Package manifest

- **`cascade/package.json`** — sub-package manifest. `bin: cascade` entry point; runtime deps: `yaml`, `ignore`, `tsx`, `typescript`. Publishing to a registry is deferred to Phase 2 when deploy repos need it; Phase 0 consumes it locally via `npm run cascade -- <subcommand>`.

### Scripts (`cascade/scripts/`)

- **`branch-graph.ts`** — classify local and remote branches against the registry; expose `classOf`, `parentOf`, `versionSourceOf`, `ancestorsOf`. Foundation for everything else.
- **`ownership.ts`** — derive owner per file per [ownership.md](ownership.md); produce `/.ownership_map.txt`; `--verify` mode reruns derivation and compares output byte-for-byte.
- **`merge-preserve.ts`** — wrapper around `git merge` enforcing §5: reject `--squash` and fast-forward into long-lived branches. Single entry point for all future P1/P2/P3 merges.
- **`version.ts`** — **read-only in Phase 0** (reports the current derived version for any branch; does not mutate). Full auto-bump logic lands in Phase 2.
- **`check.ts`** — CI entry point. Runs all of:
  - ownership determinism (rerun matches previous output)
  - every `ownership_rules` pattern matches at least one file (dead-rule: info)
  - safety-net patterns don't match committed files (`hygiene`: warning)
  - no squash or fast-forward merge commits on long-lived branches
  - no branch exists off an invalid base per the registry
  - no file has two independent introductions (§9 double-introduction error); suppressed when the path is listed in `ownership_overrides`
  - `ownership_overrides` entries name long-lived owners; redundant overrides reported
  - `bypass-log` format valid; all referenced commits exist (`upstream/*` entries validated by membership in the upstream-reachable set)

  Severity model: `error` (fails CI), `warning` (visible, fails only with `--strict`), `info` (hidden unless `--verbose`). Bypassed violations also hidden unless `--verbose`.
- **`bypass.ts`** — append an entry to `.cascade/bypass-log` with validation. Accepts `upstream/*` as a policy-pattern commit in addition to regular SHAs.

### CI wiring

- `check.ts` runs on every PR targeting a long-lived branch.
- Failure blocks merge.
- `bypass-log` entries suppress warnings on listed commits (does not suppress new violations).

## Out of scope for Phase 0

| Phase | Deliverable |
|---|---|
| 1 | P1 intake automation: `intake-analyze.ts`, `cascade triage` with schema-enforced tool use + post-hoc enrichment + internal validator, `cascade-intake` skill, conflict-resolution + discarded-file-inspection + introduced-file-inspection subagents |
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

### Severity model

Every rule in every script is emitted at one of four severities. Any rule in any doc can be written as "X at severity Y" and reading this table explains the consequences:

| Severity | Visible by default? | Affects exit code? |
|---|---|---|
| **error** | yes | exits 1 |
| **warning** | yes | exits 2 only with `--strict`; otherwise 0 |
| **info** | no (shown with `--verbose`) | never |
| **bypassed** | no (shown with `--verbose`) | never (the original severity is suppressed) |

**Bypass applies uniformly across severities.** A violation matched by a `bypass-log` entry is removed from the violation list *before* severities are tallied. This means a bypassed error does not fail CI, same as a bypassed warning — acknowledged exceptions must not block, or the mechanism is useless. The trade is documented as an accepted risk in [artifacts.md § bypass-log](artifacts.md) (trust-based: any committer can suppress any rule by appending to the log).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | clean, or only bypassed/info violations |
| 1 | at least one non-bypassed error |
| 2 | warnings only (returned only with `--strict`) |
