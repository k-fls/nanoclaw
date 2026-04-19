# Phases

Implementation is split into six phases. Each is independently shippable — earlier phases deliver value without waiting for later ones. Phase 0 is prerequisite; the rest can be re-ordered if priorities shift, with the caveats in [§ Dependencies](#dependencies).

## Phase 0 — Foundations

Make the repo legible under the model and fail CI on violations. No processes yet.

**Deliverables**
- `.cascade/branch-classes.yaml`, `.cascade/config.yaml`, `.cascade/ownership_rules`, empty `.cascade/bypass-log`
- `branch-graph.ts` — branch classification, `classOf` / `parentOf` / `versionSourceOf` / `ancestorsOf`
- `ownership.ts` — derivation + `/.ownership_map.txt` + `--verify` mode
- `merge-preserve.ts` — enforce §5 merge mode (no squash, no FF into long-lived branches)
- `version.ts` — **read-only** (report derived version; no mutation)
- `check.ts` — CI entry point running determinism, ownership, merge-mode, base, and bypass-log checks
- `bypass.ts` — append to `bypass-log` with validation

**Done when**
- `cascade check` exits 0 on a clean repo
- A squash merge into `core` causes `cascade check` to fail
- `/.ownership_map.txt` regenerates byte-identically across runs
- A branch with disagreeing version prefixes and no `parent_branch` triggers a prefix-mismatch error
- `cascade version <branch>` correctly reports the 4-part version for every existing long-lived branch

Full scope: [phase-0.md](phase-0.md).

## Phase 1 — P1 upstream intake

Handle ongoing upstream merges with agent-drafted triage and conflict resolutions. Splits the merge into reviewable sub-merges before touching the worktree.

**Deliverables**
- `intake-analyze.ts` — read-only analysis: per-commit signals (primaryKind, files, tags, parents), aggregate file set, target-vs-base divergence intersection, conflict prediction via `git merge-tree`, upstream break points, rename tracking, two inspection-group arrays (`discardedGroups` = components whose focus files the target removed post-base and upstream kept modifying; `introducedGroups` = components whose focus files upstream added and the target never had). Produces structured JSON + human-readable pretty-print. Deterministic; cacheable by `(from_sha, to_sha, merge_base)`. See [inspection.md](inspection.md).
- `cascade divergence-report` — `git diff core..upstream/main` rendered as per-file/per-hunk JSON + text (no registry file).
- `intake-upstream.ts` — per-group merge executor (runs once per approved group). Fetch, `--no-ff` merge, conflict loop.
- `cascade-intake` skill + `cascade-triage-intake` / `cascade-inspect-discarded` / `cascade-inspect-introduced` / `cascade-resolve-conflict` agent prompts — orchestrate: analyze → inspect discarded + introduced components (parallel) → triage → human-approve plan → per-group merge loop.
- `triage.ts` — runs the triage agent via Claude Agent SDK `query()` with an in-process MCP server exposing `emit_plan` (decode-time schema-enforced via zod). Enriches draft → full plan → validates → retries on violations internally.
- `intake-validate.ts` — deterministic post-enrichment validator: contiguity, coverage, break-point singletons, intersection-coverage attention floor, conflict-resolution flag gating, inspection-verdict attention floors. Debug-accessible as `cascade intake-validate`; normally runs inside `cascade triage`.

**Done when**
- `intake-analyze.ts` runs against a real upstream range and emits both JSON and human-readable reports.
- `cascade triage` produces a validator-clean plan end-to-end on a real upstream range.
- A real upstream pull runs end-to-end through the `cascade-intake` skill: analyze → triage → plan approval → per-group merges with drafted resolutions.
- Analyzer determinism: same range produces the same output (same cacheKey + same commit order + same signals).
- `merge-preserve.ts` lands each sub-merge's resolved content with correct history.

**Risks**
- Agent silently flipping behavior during resolution (red-team finding). Mitigation: human review is mandatory; divergence-report before and after intake shows any behavioral shifts in diverged areas.
- Triage agent producing a plan that hides risk (a divergence-touching commit in an `attention: none` group). Mitigation: the validator's intersection-coverage rule catches this by construction — triage cannot ship a plan that lands an intersection file in an unattended group.

## Phase 2 — P2 downstream propagation + auto-versioning

Complete the version system and land propagation.

**Deliverables**
- `version.ts` **mutating** — auto-bump per the D-bump rules in [versioning.md](versioning.md); write tags `<branch>/<A.B.C.D>`
- `propagate.ts` + `/cascade-propagate` — dry-run planner + executor
- Prefix-mismatch enforcement halts runs with actionable errors
- `/.edition-snapshot.json` generation at edition build
- Cross-repo write path: patch handoff (default) + forge-API option
- Hotfix two-target pattern documented and supported by `cascade hotfix` helper
- Decision: edition snapshot delivery mechanism (release artifact, tagged commit, both)

**Done when**
- A core bump can flow through editions to deployments with one operator command
- Tags appear correctly at every hop of the propagation chain
- Cross-repo deploys can consume an edition snapshot and run P3 locally

## Phase 3 — Adapter model formalization

Make cross-channel skills discoverable and coverage-visible.

**Deliverables**
- Existing cross-channel skills split into shared part + `skill/<s>/<c>` adapters per §3/§4
- `adapter-coverage.ts` — scan `skill/*/*` and `module/*/*` branches; report `full` / `stub` / `n/a` per channel for each cross-channel skill
- `cascade adapters` command — render coverage table
- Integration of coverage signal into `/add-*` skill docs so users see which channels an adapter supports

**Done when**
- `cascade adapters` shows honest coverage for every cross-channel skill in the repo
- Adding a new channel to an edition surfaces a list of skills that need adapters (or stubs) for that channel

## Phase 4 — P3 reclassification

Highest-risk phase. Ships read-only first, mutating only after shadow-mode validation.

**Deliverables (4a, read-only)**
- `classify-change.ts` — signal computation (path-ownership + size/shape + diff-vs-upstream for v1) + confidence tiering
- Shadow-mode runs over recent deploy-branch history; manual validation of proposal quality
- Threshold decision: what proposal accuracy gates the mutating half

**Deliverables (4b, mutating, only after 4a validates)**
- `reclassify.ts` — ephemeral branches off proposed homes; cherry-pick hunks; open PRs
- `/cascade-reclassify` slash command
- `cascade-classify-ambiguous` agent for low-confidence hunks
- Follow-up plan storage in `.cascade/reclassify/<id>.json`
- Inline-removal step **gated on P2 confirmation** — never touches the source branch until the propagated version has landed and CI is green
- Third-outcome support: relocate clean version + keep deployment-specific delta on top

**Done when**
- Shadow mode demonstrates the v1 signals produce usable proposals on real history
- A real deploy-branch range can be reclassified end-to-end with human confirmation at each step
- No follow-up plan removes an inline version without P2 confirmation

**v2 signals** (deferred to 4c or later): symbol-dependency, import-graph, co-change, test-location, string-literal.

## Phase 5 — P4 divergence review + P5 upstream candidates

Light-touch processes whose value scales with accumulated history from earlier phases.

**Deliverables**
- `cascade divergence-report` (expanded from Phase 1's minimal version) — grouped, annotated
- `/cascade-divergences` slash command — annotate entries as keep / upstream-candidate / obsolete / investigate; annotations live in commit messages or issue tracker, not a registry
- `cascade upstream-candidates` — list candidates; build patch series against upstream's current tip; open draft PR
- `/cascade-upstream-candidates` slash command
- Outcome recording for attempted upstream contributions (accepted / rejected / closed / superseded)

**Done when**
- Quarterly divergence review can be run through `/cascade-divergences`
- An upstream candidate can be turned into a draft upstream PR through `/cascade-upstream-candidates`
- Rejected candidates are not re-attempted without a reason recorded

## Dependencies

```
Phase 0 (foundations)
   │
   ├── Phase 1 (P1 intake) ────┐
   │                           │
   └── Phase 2 (P2 + versions)─┼── Phase 3 (adapters)
                               │        │
                               │        └── Phase 4 (P3) ── Phase 5 (P4/P5)
                               │                    ▲
                               └────────────────────┘
```

- **Phase 0** is prerequisite for everything. Nothing ships without the registry, graph, and ownership derivation.
- **Phase 1 and Phase 2** are parallelizable after Phase 0, but Phase 2 is more useful with Phase 1's intake pipeline already delivering upstream changes to propagate.
- **Phase 3** needs Phase 2 because adapter coverage only matters when editions can be assembled and propagated.
- **Phase 4** needs Phase 2 (P3 follow-up plans depend on P2 propagation) and benefits from Phase 3 (classifications need a clean adapter model to propose correct homes).
- **Phase 5** needs Phase 1 having been in use long enough to accumulate real divergence data, and needs Phase 4's classifier for "obsolete" detection.

## What each phase costs in complexity

| Phase | New scripts | New slash commands | New agent subroutines | Risk |
|---|---|---|---|---|
| 0 | 5 | 0 | 0 | low |
| 1 | 1 + enhancements | 1 | 1 | medium (agent can flip behavior) |
| 2 | 2 + `version.ts` mutating | 1 | 0 | medium (version bugs cascade) |
| 3 | 1 | 0 | 0 | low |
| 4a | 1 (read-only) | 0 | 0 | low (no mutations) |
| 4b | 1 + follow-up infra | 1 | 1 | **high** (mutating across branches; inline-removal errors corrupt deploys) |
| 5 | 2 | 2 | 0 | low |

Phase 4b is the piece that gets the most scrutiny. Shadow-mode validation in 4a is what makes 4b safe to build.

## What's explicitly not on the roadmap

- No separate `main` branch (§13).
- No central ownership registry file (§13).
- No commit-message prefix convention (§13).
- No union-of-all-channels branch (§13).
- No automatic merge of anything into a long-lived branch without human confirmation (§13, §11 P3).
- No LLM involvement in versions, manifests (there are none), ownership, or propagation mechanics — only in P1 conflict drafts and P3 ambiguous classification.
- No Copybara, Bazel, Starlark — cross-repo sync uses patch handoff and optional forge API.
