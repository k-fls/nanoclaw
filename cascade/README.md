# Cascade

Automerge tool for fls-claw. Coordinates merges, ownership derivation, and versioning across a layered branch hierarchy (upstream → core → modules/channels/skills → adapters → editions → deployments).

## Contents

```
cascade/
├── docs/          ← full specification
├── scripts/       ← implementation (TS; Phase 0 in progress)
├── hooks/         ← optional git hook samples
└── package.json   ← sub-package metadata (added at Phase 2 publish time)
```

Repo-level tracking data lives at `.cascade/` in the repo root (not under this folder), consistent with `.github/`, `.vscode/` and similar "config consumed by a tool" conventions. See [docs/artifacts.md](docs/artifacts.md) for the schema.

## Start here

- **New to cascade?** [docs/README.md](docs/README.md) — design principles and map of the spec.
- **Looking at the model?** [docs/branch-model.md](docs/branch-model.md) and [docs/ownership.md](docs/ownership.md).
- **Implementing?** [docs/phase-0.md](docs/phase-0.md).
- **Planning?** [docs/phases.md](docs/phases.md).

## Requirements source

Cascade implements the branch model and processes specified in [../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md](../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md). When the spec and the requirements disagree, the requirements doc is authoritative.

## Cascade's own branch

Cascade is itself a module (`module/cascade`) under the branch model it implements. Files under `cascade/` are owned by `module/cascade`; the `.cascade/` tracking folder at the repo root is `project`-owned (shared config consumed by tooling, not source code).

Development happens on `module/cascade` from Phase 0 onward — not on an ephemeral branch. This keeps the model self-consistent from day one: once `check.ts` works, it starts validating its own repo (including its own code path). The bootstrap gap during Phase 0 (enforcer doesn't exist yet while being built) is accepted.

## Status

Phase 0 (foundations) — in planning, to be developed on `module/cascade`. No scripts implemented yet.
