# Automerge — FLS-Claw branching implementation

Implementation spec for the branch model, ownership, versioning, and processes defined in [../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md).

## Contents

- [branch-model.md](branch-model.md) — branch classes, authoring flows, merge rules
- [ownership.md](ownership.md) — ownership rules, states, derivation, map file
- [versioning.md](versioning.md) — 4-part versions, auto/manual D-bumps, tagging
- [artifacts.md](artifacts.md) — complete persistent surface and file schemas
- [processes.md](processes.md) — P1–P5 with the three-tier design
- [phases.md](phases.md) — full phase roadmap (Phase 0 through Phase 5)
- [phase-0.md](phase-0.md) — detailed scope for the first implementation phase
- [inspection.md](inspection.md) — contract for the P1 inspector subagents (discarded + introduced)

## Design principles

1. **Derivation over declaration.** Files that aren't read rot. Prefer deriving state from git over hand-maintained files. File ownership lives in the branch graph. Inclusion in an edition lives in merge history. Version lives in tags. No duplicates.
2. **Three tiers: scripts, agents, humans.** Scripts do deterministic mechanics. LLM agents draft judgment calls in exactly two places (P1 conflict resolution, P3 ambiguous classification). Humans confirm anything that merges into a long-lived branch.
3. **Mechanical enforcement over convention.** Rules live in `check.ts` (CI), not in contributor discipline. The requirements doc §1 explicitly forbids reliance on commit-message conventions; the same principle applies everywhere.
4. **Narrow LLM surface.** Agents never touch manifests, versions, ownership, or propagation. They only draft resolutions for conflicts and classifications that humans then confirm.

## Summary of persistent surface

Committed:
- `.cascade/branch-classes.yaml` — branch class patterns
- `.cascade/config.yaml` — repo-wide knobs
- `.cascade/ownership_rules` — gitignore-style patterns; `?` prefix marks safety-net
- `.cascade/ownership_overrides` — explicit `path  owner` for ambiguous history
- `.cascade/parent_branch` — per-branch, only on editions that need it
- `.cascade/bypass-log` — append-only log of acknowledged CI bypasses; supports `upstream/*` policy entries

Derived (gitignored or build-time):
- `/.ownership_map.txt` — path → owner, regenerated
- `/.edition-snapshot.json` — shipped to cross-repo deploys
- Git tags `<branch>/<A.B.C.D>` — written by `cascade merge`/`cascade tag`

Everything else is computed at runtime from git.
