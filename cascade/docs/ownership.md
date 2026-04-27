# Ownership

Implements [§9 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md).

## States

| State | Meaning |
|---|---|
| `<branch>` | File was introduced on that branch. Normal case. Survives modifications by other branches. |
| `project` | File matches an entry in `.cascade/ownership_rules`. Shared; no single branch owns it. P3 never proposes relocation for these. |
| `default` | File predates tracking or has no determinable introduction. Ownership treated as "unchanged" by modifications. A new file introduced on branch X while X holds `default` semantics is owned by X from that point. |

### File ownership vs. change ownership

File ownership is stable; change ownership is per-hunk. A skill branch can modify a core-owned file and the *file* stays core; the *hunk* is a skill integration edit (§8).

Hunk ownership is **not stored**. If a tool needs line-level attribution it consults `git blame` on demand. V1 P3 signals don't need blame at all.

## `.cascade/ownership_rules`

Gitignore-syntax patterns for project-owned paths.

```
# Lockfiles — legitimately committed
package-lock.json
yarn.lock
pnpm-lock.yaml

# Safety-net: shouldn't be committed
?node_modules/
?vendor/
?dist/
?build/
?*.generated.ts
?*.generated.js
?container/*.tgz

# Escape hatch: force a matched path back into branch derivation
!src/version.generated.ts
```

Prefix semantics:
- Bare pattern → project-owned. Dead-rule reports at info severity.
- `?pattern` → safety-net: should NOT be committed. Dead-rule is info; a committed match triggers a `hygiene` warning. The prefix is local and self-describing — no section markers to scan up for.
- `!pattern` → negation: force back into branch-introduction derivation.
- Matches standard `.gitignore` evaluation order (later entries override earlier).

## `.cascade/ownership_overrides`

Explicit `path  owner-branch` mapping for files whose history is genuinely ambiguous — pre-cascade squash/cherry-pick duplication, cross-branch re-authoring, or anything else that leaves derivation without a single correct answer. Consulted *before* mechanical derivation.

```
src/dir-fingerprint.test.ts    main
src/interaction/session.ts     main
```

Effects on a matched path:
- Ownership returns the declared owner directly.
- Double-introduction warning is suppressed (the human has acknowledged the history).
- `check.ts` flags overrides naming non-long-lived owners (`override-invalid`, error) and redundant overrides whose owner matches derivation (`override-redundant`, info).

This is the escape hatch for ambiguity, not a central ownership registry. If the list grows beyond a handful of entries, the signal is that derivation or the branch model needs attention — not that more overrides should be added.

## Derivation algorithm

Single pass over all introduction commits across reachable history:

```
# one git call collects every file introduction across every branch
git log --all --diff-filter=A --name-only --format='COMMIT %H %P'
  → file_to_introducing_commits
# merge-commit false positives filtered: if an "added" file on a merge
# commit existed on any non-first parent, it is not a real introduction.

for each file F in current tree (sorted):
  if F has an ownership_overrides entry:
    owner = declared_owner; continue   # escape hatch (consulted first)

  if F matches ownership_rules (after !negations):
    owner = "project"; continue

  introducing_commits = file_to_introducing_commits[F]
  if empty:
    owner = "default"; continue

  # All stages iterate long-lived branches in branch-classes.yaml order
  # (core, modules, channels, skills, adapters, editions, deploys;
  # ephemerals are never candidates). First match wins within each stage.

  if introducing_commits describe independent timelines (≥2 intros, none an
     ancestor of any other):
    # Independent-timeline tiebreak. A single-parent rebase/squash from
    # upstream that re-adds an already-committed file looks like a
    # first-parent introduction on the downstream branch — but the file's
    # true home is upstream. Collapsing fp+anc within registry order keeps
    # attribution on the most-general branch with any reach to an intro.
    owner = first long-lived branch, in registry order, whose first-parent
            chain OR full ancestry contains any of introducing_commits
  else:
    # Stage 1: the branch where the commit was authored — its --first-parent
    # chain contains the intro commit directly.
    owner = first long-lived branch, in registry order, whose first-parent
            chain contains any of introducing_commits

    # Stage 2 (only if Stage 1 did not match): the branch that absorbed the
    # commit via merge (upstream imports, ephemeral merges). Its full
    # ancestry contains the intro. Same iteration order.
    if not matched:
      owner = first long-lived branch, in registry order, whose full
              ancestry contains any of introducing_commits

  # Stage 3 (only if Stages 1 and 2 did not match): upstream-reachability.
  # A commit reachable from any read-only (upstream) ref maps to the core
  # class's canonical branch. Covers the mid-intake case: a scratch branch
  # has merged upstream, bringing upstream-introduced files into the tree,
  # but main/core's ref hasn't FF'd yet. The file is definitionally core's
  # per §2 (upstream flows to core); Stage 3 makes ownership reflect that
  # regardless of whether the FF has happened.
  if not matched:
    if introducing_commits are reachable from any upstream/* ref:
      owner = the core class's canonical branch

  if still no match:
    owner = "default"
```

Cost: one `git log` pass plus one `git branch --contains` per unique introducing commit. Scales to repos of ~10k files in single-digit seconds.

**Renames are introductions at the new path (per §9).** No `--follow`. A rename = new introduction; the branch performing the rename owns the file at its new path. The introduction-collection log passes `--no-renames` so git's diff machinery cannot reclassify the new path as `R` and silently drop it from `--diff-filter=A`. This matches the requirements directly and removes a determinism risk — git's rename-detection heuristics aren't consulted for attribution, so cross-platform CI disagreements are impossible.

**Delete-and-recreate.** A file deleted and later added at the same path is a fresh introduction. The recreating branch owns it. To preserve ownership, patch instead of delete.

**Ephemerals are never candidate owners.** Ownership candidates are long-lived branches only. A file whose introducing commit lives on a merged-and-deleted ephemeral is owned by the first long-lived branch whose ancestry contains that commit — typically the branch the ephemeral was merged into. This handles the common case of pre-registry feature branches cleanly without a migration step.

## `/.ownership_map.txt`

Derived. Gitignored. Regenerated by `cascade ownership` or automatically as part of `check.ts`.

Format: one line per file, sorted by path:

```
container/skills/browser/index.ts    skill/browser
package-lock.json                    project
src/channels/registry.ts             core
src/channels/telegram/sender.ts      channel/telegram
src/index.ts                         core
```

Grep-friendly, diff-friendly, human-inspectable without tooling. Never a source of truth — always regenerable.

## `check.ts` guarantees for ownership

- **Determinism**: two consecutive derivations produce the same map. Achieved by treating renames as introductions (no `--follow`, no rename-heuristic dependency).
- **No double introduction**: no file introduced on two branches in independent history. Warning when the introducing commits are on ephemerals / unclassifiable refs (benign legacy noise); error when two long-lived branches' first-parent chains each contain a distinct introducing commit. Three deterministic suppressions, applied in order — each is a blob-hash equality check (no heuristics):
  - **Rename-induced**: one introducer is a `git mv` whose target is this path. The second "introduction" is the rename surfacing under `--no-renames`, not a real second authoring. Git's rename heuristic is consulted for this *advisory* check only; it never feeds owner attribution.
  - **Content-equivalent at intro**: all introducers store the same blob at this path. The same content reappeared via cherry-pick / rebase / squash-from-upstream, not two independent authorings.
  - **Reconciled in tree**: introducers had differing blobs at intro time, but the current tree blob matches one of them. The divergence has been resolved (the surviving content is one of the original introductions). The historical record stays in git log.
  Overrides in `.cascade/ownership_overrides` also suppress the warning for the overridden path (the human has acknowledged the history).
- **Dead rules**: every `ownership_rules` pattern matches at least one current file, else info. Dead safety-net rules are expected and informational; a safety-net pattern that *does* match a committed file is a warning (`hygiene`).
- **Unowned new files**: a newly-added file whose first-introduction commit isn't reachable from any long-lived branch requires an explicit ownership decision before `check.ts` passes.
- **Override hygiene**: overrides naming a non-long-lived owner are errors (`override-invalid`); overrides whose declared owner already matches derivation are info (`override-redundant`). Because info severity is hidden by default, `cascade check` also prints a single-line notice (`notice: N override(s) appear redundant ...`) whenever any are present, so the rot signal stays visible without noise.
