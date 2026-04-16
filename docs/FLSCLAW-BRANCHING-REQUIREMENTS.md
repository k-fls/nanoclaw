# FLS-Claw — Branching & Procedures Requirements

Status: requirements. No implementation details specified here.

## 1. Scope and goals

FLS-Claw is a commercial fork of nanoclaw with three concerns the upstream model does not address:

1. Staying current with nanoclaw while preferring fls fixes and functionality.
2. Maintaining non-trivial core improvements that cannot be expressed as nanoclaw-style skills.
3. Supporting multiple deployments, each potentially in a private repository, while allowing changes made at any layer to be redistributed to the correct layer.

The system must make these three concerns manageable through a branch model, a set of rules, and a set of repeatable processes. It must not rely on contributor discipline for correctness (e.g. commit-message conventions).

## 2. Branch classes

The repository must support the following branch classes. Each has defined lifetime, base, and purpose.

- **Upstream tracking branches** — read-only mirrors of `nanoclaw` main and of each upstream skill branch. Long-lived.
- **`core`** — the single integration trunk. Contains: the upstream mirror, trivial fls fixes, and all merged modules. Long-lived.
- **`module/<name>`** — a non-trivial core improvement kept isolated from the bulk of core for reviewability. Branched from `core`. Merges back into `core` when updated. Long-lived.
- **`channel/<name>`** — per-channel branch. Branched from `core`. Incorporates the corresponding upstream skill branch plus fls-specific channel patches. Long-lived.
- **`skill/<skill_name>/<channel_name>` and `module/<module_name>/<channel_name>`** — per-channel adapter branches for a cross-channel skill or module. Long-lived. Their base and composition with the parent skill/module and the target channel are defined in section 3.
- **`edition/<name>`** — a consumable assembly of `core` plus a selected subset of channels, non-channel skills, and the adapter branches required to make the selected skills work on the selected channels. Long-lived.
- **`deploy/<name>`** — per-deployment branch. Branched from an edition. May live in a private repository. Long-lived. Structure is free-form per deployment.
- **Ephemeral branches** — short-lived branches used to land a single fix or feature into any of the above. Deleted on merge.

The model does not include a general-purpose `main` branch distinct from `core` to avoid collision with the upstream. 

## 3. Cross-channel skill model

Skills that conceptually apply across multiple channels (media handling, reactions, reply threading, and similar) must be expressible without forcing all channels to be bundled together and without duplicating the skill across channel branches.

The model must decompose such skills into two parts:

- **Shared part** — the interface, data model, routing, and any storage common across channels. Lives as a module or a skill.
- **Per-channel adapter** — the channel-specific integration with that channel's API. Lives as commits on the relevant `skill/<skill_name>/<channel_name>` or `module/<module_name>/<channel_name>` branch.

Per-channel adapters must be optional: a channel may have a full adapter, a stub, or declare the capability not applicable. Editions must be able to include or exclude individual channels without being forced to take all of them.

Each shared part must make its adapter coverage discoverable (which channels have adapters, which stubs, which are not applicable).

## 4. Branch flow

The system must support the following flows.

### Authoring (where a branch is cut from)

- Upstream → `core`.
- `core` → `module/<name>`.
- `core` → `channel/<name>`, incorporating the corresponding upstream skill branch.
- `core` → `edition/<name>`.
- `edition/<name>` → `deploy/<name>`.
- Per-channel adapter branches (`skill/<skill_name>/<channel_name>` or `module/<module_name>/<channel_name>`) are **based on their parent skill or module branch**, not on `core` and not on the target channel. The target channel is not a git ancestor of the adapter; it is composed with the adapter at build time. This choice:
  - aligns the branch graph with the naming hierarchy (`skill/<s>/<c>` is a sub-branch of `skill/<s>`);
  - lets updates to the parent skill/module flow into the adapter as ordinary git merges, catching interface drift at merge time rather than deferring it to CI;
  - matches the section 8 layout rule that a sub-skill lives inside its parent skill's subfolder.
- Updates to the target channel do not flow into the adapter through git; the adapter must be verified against its target channel at build/CI time. The requirement is that an adapter remains buildable and testable against both its parent skill/module and its target channel, and stays compatible with updates to either side.

### Ongoing merges

- Upstream → `core`.
- `module/<name>` → `core`.
- Upstream skill branch → `channel/<name>`.
- `core` → `channel/<name>`.
- `core` → `edition/<name>`.
- `channel/<name>` → `edition/<name>` (edition selects which channels).
- Non-channel skill branch → `edition/<name>` (edition selects which skills).
- Adapter branch (`skill/<skill_name>/<channel_name>` or `module/<module_name>/<channel_name>`) → `edition/<name>`, when the edition has opted into both the parent skill/module and the target channel.
- Updates to a parent skill/module and to its target channel must flow into the corresponding adapter branches so adapters stay compatible with both sides.
- `edition/<name>` → `deploy/<name>`.

### Reclassification

- `deploy/<name>` → `core`, `module/<name>`, `channel/<name>`, a skill branch, or a per-channel adapter branch, for changes originally made at the deployment layer that belong upstream of it.

The model must not require editions to merge modules directly. Modules reach editions transitively through `core`.

## 5. Merge mode rules

Merges into any long-lived branch must preserve history to keep future merges from that source viable. Squash merges must be used only for ephemeral branches that are deleted on merge. This rule applies uniformly: modules, channels, skills, editions, and deployments must all be merged with history preserved.

The system must provide a way to read the high-level history of a long-lived branch without being overwhelmed by detail from merged-in branches.

## 6. Versioning

The system must support versioning with the following rules:

- **`core`** — its version must be derivable from and correlated with the upstream version it mirrors, plus a counter for fls-specific patches applied on top of that upstream point.
- **`module/<name>`** — modules need no versioning of their own; they are tied to `core` and travel with its version.
- **`edition/<name>`** — each edition must have a version, with clear semantics for major (breaking to deployments), minor (additive), and patch (propagated fixes). Editions are recommended to follow `core` versioning for the first two or three semver numbers, so an edition version implies the core version it is built on.
- **`deploy/<name>`** — each deployment must be pinnable to a specific edition version.

Given a deployment, the versioning scheme must allow determining the edition it tracks and, via the edition, the core version it is built on.

## 7. Upstream precedence on intake

When upstream changes conflict with fls changes, resolution must be **by functionality, not by textual overlap**. The system must maintain a living record of fls's deliberate divergences from upstream. Each divergence record must include at minimum:

- the upstream behavior
- the fls behavior
- the rule for what to do when upstream changes in that area
- an owner
- a last-reviewed date
- an indication of whether the divergence is a candidate for contributing back upstream

During upstream intake, the divergence record must drive resolution decisions. Divergences whose review date has lapsed must surface for re-review.

## 8. Code layout rules

### Skills (required, with defined exceptions)

- Each skill must own a dedicated subfolder for its code.
- A skill that extends a single other skill may live as a dedicated subfolder inside the parent skill's subfolder rather than at the top level.
- A skill that connects multiple other skills may legitimately have no single dedicated folder, because its code has to live where the skills it connects live. In that case, its footprint must still be small and clearly attributable (see the minimal-edit rule below).
- Cross-cutting integration points must live in dedicated files owned by the skill, not as inline edits scattered through existing files.
- When an inline edit to a shared file is genuinely unavoidable, it must be minimal — a registration call, an import, a single dispatch entry — and not contain skill logic.
- A proposed skill that cannot meet these rules must be triaged: it may be better classified as a module or a direct core change, or it may legitimately be a sub-skill of another skill or a connector skill (in which case the corresponding layout exception above applies).

### Modules (diagnostic)

- The same layout preference applies — dedicated subfolder and isolated integration files.
- The ability of a proposed change to fit this layout is the primary diagnostic for whether it should be a module at all:
  - Fits cleanly → genuine module.
  - Does not fit — changes sprawl across many existing files with no separable surface — → it is probably not a module but a direct core change (or it needs a prior core refactor that extracts an interface before the module can be built).

## 9. Ownership

Ownership of a file by a branch must be a defined, derivable property of the repository, not a separate convention that can drift.

### Attribution rule

A file is owned by the branch that **introduced** it. Subsequent modifications to that file by other branches are integration edits and do not transfer ownership.

### Derivability

The ownership map must be derivable from the branch graph and commit history alone. Cached representations of ownership that live alongside the code are permitted for performance but must be verifiable against the derived truth; when cache and derivation disagree, derivation wins and the cache must be reconciled.

### Consequences

- Files introduced directly on `core` (including those imported from upstream) are owned by `core`.
- Files introduced on a `module/*`, `channel/*`, or skill branch are owned by that branch.
- A new file added in a commit without a clear owning branch requires an explicit ownership decision before it is accepted.
- Two branches cannot claim to have introduced the same file; such a state is a detectable error.

### Edge cases

- **File moves and renames** count as introductions at the new path. The branch that performs the move owns the file at the new path from that point forward. The old path's ownership record becomes historical and does not transfer automatically.
- **Adapter branches and parent precedence.** Because an adapter branch (`skill/<s>/<c>` or `module/<m>/<c>`) is based on its parent skill/module (section 4), files inherited from the parent are already owned by the parent by the standard introduction rule. An adapter branch owns only files it genuinely introduces itself on top of its parent. A file introduced on the parent and later moved or modified on the adapter stays owned by the parent.
- **Target channel not in ancestry.** The target channel is not a git ancestor of the adapter; channel-owned files do not appear on the adapter branch and do not interact with the adapter's ownership map. At build-time composition, files from the channel and files from the adapter coexist in the working tree but retain their separate ownership — collisions between them are detectable errors.

## 10. Reclassification (P3) requirements

The system must be able to process a range of commits on a deployment (or other leaf) branch and determine, for each change within those commits, its proper home in the layered model. Classification is per-change, not per-commit: a single commit may legitimately contain changes that belong on different branches and be split during reclassification. Classification uses two independent signals.

### Path-ownership signal

- A change to a file owned by a single branch is a candidate for relocation to that branch.
- A commit whose changes fall across files owned by multiple branches is mixed; it is split, and each part classified independently.
- A change that adds a new file not yet owned requires an ownership decision as part of reclassification.
- A change to a file owned by `core` is a legitimate core change.

### Symbol-dependency signal

- A newly added function, class, or type whose dependencies (the symbols it references) are all satisfied within a single branch and its ancestors is a candidate for relocation to that branch. It is authored higher than necessary.
- This signal applies to additions, not to modifications of existing symbols.
- The signal is advisory; legitimate reasons exist to author a symbol higher than its current dependencies require (e.g. anticipated reuse).

### Human-in-the-loop

Reclassification must never merge to a long-lived branch without human confirmation. The system produces proposals; humans confirm, split, or override. Mixed, ambiguous, or unrecognized commits are escalated with enough context for a human to make a decision.

### Disallowed

The system must not rely on commit-message prefixes or any other author-side convention to determine classification. Signals must come from the code and the branch graph.

## 11. The five processes

The system must support the following processes. Each process has defined inputs, outputs, and guarantees, but implementation is not specified here.

### P1 — Upstream intake

**Input:** new commits on upstream nanoclaw and upstream skill branches.
**Output:** updated `core` and updated `channel/<name>` branches.
**Guarantees:** divergences are respected per the divergence record; history is preserved; per-functionality precedence rules are applied; fls fixes and functionality are preferred where they exist.

### P2 — Downstream propagation

**Input:** an updated `core`, updated modules, updated channels.
**Output:** updated editions; updated deployments.
**Guarantees:** editions receive `core` updates (and therefore module updates) and the updates of channels and skills they have opted into; deployments receive edition updates; nothing an edition or deployment did not opt into is introduced silently.

### P3 — Reclassification

**Input:** a range of commits on a deployment or development branch (the *source* branch).

**Output:**
- A set of proposed per-change relocations to `core`, modules, channels, skill branches, or per-channel adapter branches, with commits split where changes belong to different homes.
- A list of escalations for changes that cannot be classified mechanically.
- For each accepted relocation, a follow-up plan that (a) triggers P2 so the relocated change propagates back down through its layer and reaches the source branch via the normal flow, and (b) removes or replaces the original inline version on the source branch so the change is not duplicated once the propagated version lands.

**Guarantees:**
- Classification is per-change, not per-commit.
- Classification uses path-ownership and symbol-dependency signals.
- No relocation is final without human confirmation.
- No author-side convention is relied upon.
- After a relocation and its follow-up propagation complete, the source branch contains the relocated change exactly once, sourced from its proper home, with no orphaned duplicate of the original inline version.

### P4 — Divergence review

**Input:** the divergence record.
**Output:** refreshed review dates, updated rules, removed entries for divergences that have been eliminated.
**Guarantees:** divergences past their review date are surfaced; stale rules do not drive intake.

### P5 — Upstream candidate review

**Input:** divergence records flagged as upstream candidates.
**Output:** attempted upstream contributions and outcomes recorded back in the divergence record.
**Guarantees:** a visible queue exists; a candidate that has been attempted and rejected is recorded so it is not re-attempted without reason.

## 12. Deployment repository freedom

The model must not constrain how deployment repositories are organized. Deployments may live in the main repository, in separate private repositories, or in a shared private repository with one branch per deployment. Reclassification and propagation processes must work across repository boundaries.

## 13. Explicit non-requirements

- No central ownership registry file.
- No commit-message prefix convention.
- No `main` branch distinct from `core`.
- No union-of-all-channels branch.
- No forced inclusion of all channels or all skills in any edition.
- No automatic merge of reclassified commits into long-lived branches without human confirmation.
- No requirement that fls diverge minimally from upstream; divergence is acceptable when justified and recorded.
- No assumption that upstream will accept fls contributions; upstreaming is opportunistic, not structural.
