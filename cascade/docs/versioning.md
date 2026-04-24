# Versioning

Implements [§6 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md).

## Structure

Every branch has a 4-part version: **`A.B.C.D`**

- `A.B.C` — prefix. 3 parts inherited from the version source.
- `D` — per-branch counter.

Uniform across all branch classes. Config: `.cascade/config.yaml` sets `version_depth: 3` (how many parts of the parent/upstream version form the prefix). Fixed once per repo.

## Version sources

| Branch | Version source |
|---|---|
| `core` | `upstream/main` (upstream's own version) |
| `module/<name>` | `core` *(prefix source only; module branches themselves are not tagged)* |
| `channel/<name>` | `core` *(prefix source only; channel branches themselves are not tagged)* |
| `skill/<name>` | `core` |
| `skill/<s>/<c>` | `skill/<s>` |
| `module/<m>/<c>` | `module/<m>` *(see module note)* |
| `edition/<name>` | declared in `.cascade/parent_branch` on the edition branch |
| `deploy/<name>` | the edition it merges from (implicit) |

**Which branches get tagged — first-class artifacts vs. carriers.** The rule: a branch gets its own `<branch>/A.B.C.D` tag iff it is an independent artifact with its own lifecycle. The registry encodes this via `not_versioned: true` on the carrier classes.

- **Tagged** (first-class): `core`, `edition/<name>`, `deploy/<name>`, `skill/<name>`, `skill/<s>/<c>`. Skills evolve, ship, and are consumed at their own cadence — "which version of skill X is in edition Y?" is a real question and the tag answers it cheaply.
- **Not tagged** (carriers bound to core): `module/<name>`, `channel/<name>`. A module is a structural partition of core; a channel is a transport adapter for core. Neither has an independent lifecycle. A `module/<name>/A.B.C.D` tag would be a redundant restatement of `core`'s version at the last propagate, and "what channel version shipped in edition X?" is not a meaningful question under this framing — it collapses to "what version of `core` shipped in edition X?", which the `core` tag already answers. If a channel or module ever diverges from `core`, that's a bug (caught by `check.ts` prefix-mismatch and tag-discipline rules), not a state worth recording in a tag.

Requirements §6 makes this call explicitly for modules; we extend the same reasoning to channels and leave skills on the versioned side. Phase 2 `cascade propagate` still merges `core` into channel/module branches so they don't drift, but writes no tag for them.

## Prefix derivation on merge

On merge into branch X:

1. Collect versioned sources being merged (by direct ancestry of the merge commit).
2. **All sources share same A.B.C** → use that A.B.C.
3. **Sources disagree**:
   - If `.cascade/parent_branch` present on X → use that source's A.B.C; warn that a mixed-version state is being produced.
   - Else → `check.ts` errors with a prefix-mismatch message listing disagreeing sources.

This creates natural pressure to refresh children from core before merging them into editions. The hygienic fix ("refresh channel/whatsapp from core first") is the fix most operators will reach for.

## D-bump rules

| Trigger | Behavior |
|---|---|
| Version source's prefix advanced since last tag on X | D = 1, auto-tag |
| Version source's D advanced, same prefix | D++, auto-tag |
| Merge from non-source (sibling, ephemeral), direct commit | no auto-bump; `cascade tag <branch>` to release (D++, tag) |
| No-op merge (nothing new in tree) | nothing |

This separates "version moved because upstream/core moved" (automatic, deterministic) from "version moved because we chose to release" (human act).

## Remembering previous parent D

Derived from git at bump time. No suffix, no side file:

```
at X's last tag commit, find the version source's tag at that point.
compare to the source's current tag.
  prefix advanced → reset D = 1, tag.
  D advanced, same prefix → D++, tag.
  unchanged → no-op.
```

Cheap: one tag lookup + one merge-base walk per bump.

## Editions without `parent_branch`

Prefix still auto-derives from the all-sources-agree rule. But **auto-bump is disabled** — every D bump is user-induced via `cascade tag edition/<name>`. Absence of the file is a deliberate choice: "I want explicit control over this edition's releases."

Most editions will want `parent_branch` pointing at `core`. It's the auto-bump enabler.

## Tag naming

`<branch>/<A.B.C.D>`

```
core/1.9.0.5
skill/reactions/1.9.0.2
skill/reactions/telegram/1.9.0.1
edition/starter/1.9.0.2
deploy/prod-acme/1.9.0.2
```

(Modules and channels don't get their own tags — see the carrier note above.)

Namespaced to keep the flat tag space navigable. `git tag -l 'edition/starter/*'` shows only that edition's releases.

## Version comparison

4-tuple integer compare (lexicographic over `(A, B, C, D)`).

**Do not use standard semver libraries** — they assume 3 components and either reject or misinterpret 4-part versions. Use `cascade version compare` as the canonical comparator.

## Cross-repo pinning

A deploy repo (possibly in a separate private repo) pins to an edition tag. The pin is established by the merge of the edition into the deploy branch. `cascade version deploy/<name>` reports the full chain:

```
$ cascade version deploy/prod-acme
deploy/prod-acme     1.9.0.2
  ← edition/starter  1.9.0.2   (merged 2026-04-01)
  ← core             1.9.0.5   (at time of edition merge)
  ← upstream         1.9.0     (nanoclaw)
```

No separate pin file; the merge commit is the pin.

## Propagation order implied by prefix rule

P2 execution order falls out of the prefix rule without extra plumbing:

1. `upstream → core`
2. `core → module/*`, `core → channel/*`, `core → skill/*`
3. `skill/<s> → skill/<s>/<c>`, `module/<m> → module/<m>/<c>`
4. `{core, channel/*, skill/*, adapter/*} → edition/*`
5. `edition/* → deploy/*`

Out-of-order execution produces prefix mismatches at step 4 and stops the run with an actionable error.
