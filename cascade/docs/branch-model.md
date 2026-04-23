# Branch model

Implements [§2, §4, §5 of the requirements](../../docs/FLSCLAW-BRANCHING-REQUIREMENTS.md).

## Branch classes

| Class | Pattern | Base | Version source | Lifetime |
|---|---|---|---|---|
| Upstream mirror | `upstream/*` | n/a (read-only) | n/a | long |
| Core | `core` | `upstream/main` | upstream | long |
| Module | `module/<name>` | `core` | core | long |
| Channel | `channel/<name>` | `core` | core | long |
| Non-channel skill | `skill/<name>` | `core` | core | long |
| Skill adapter | `skill/<skill>/<channel>` | parent skill | parent skill | long |
| Module adapter | `module/<module>/<channel>` | parent module | parent module | long |
| Edition | `edition/<name>` | `core` | declared in `.cascade/parent_branch` | long |
| Deployment | `deploy/<name>` | edition | edition merged in | long (may be in private repo) |
| Ephemeral | any | any | n/a (not versioned) | short; deleted on merge |

Registry file: `.cascade/branch-classes.yaml`. Maps regex patterns to class metadata. All tooling reads this.

## Authoring flows (where a branch is cut from)

- `upstream/main → core`
- `core → module/<name>`
- `core → channel/<name>`, incorporating `upstream/skill/<name>`
- `core → skill/<name>` (non-channel skills)
- `skill/<s> → skill/<s>/<c>` — adapters branch from parent skill, not from channel. Per requirements §4: aligns naming with the branch graph, catches interface drift at merge time.
- `module/<m> → module/<m>/<c>` — same rule.
- `core → edition/<name>`
- `edition/<name> → deploy/<name>`

Target channel is not a git ancestor of an adapter. The adapter is composed with the channel at build time (via merge into the edition).

## Ongoing merges

- `upstream/main → core`
- `upstream/skill/<name> → channel/<name>`
- `core → module/*`, `core → channel/*`, `core → skill/*`
- `skill/<s> → skill/<s>/<c>`, `module/<m> → module/<m>/<c>`
- `{core, channel/*, skill/*, adapter/*} → edition/<name>` — edition selects by merging.
- `edition/<name> → deploy/<name>`

Updates reach modules through core (no direct module → core fast path). Editions pick up module updates transitively through core.

## Hotfix two-target (supporting flow)

Not classification, not reclassification. A named pattern for emergencies:

1. Ephemeral branch off `core` with the fix.
2. Cherry-pick to `deploy/<name>` immediately. `cascade tag deploy/<name>`.
3. Merge to `core` same day.
4. Normal P2 propagates the fix back down to the deploy.
5. `check.ts` recognises the cherry-pick and propagated version as the same fix; the loop is closed.

Loop closure uses a `Cascade-Hotfix-Pair: <sha>` commit trailer written symmetrically on both the cherry-pick and the `core` merge by `cascade hotfix`. This is derived discipline (script-written, machine-parsed), not the author-side convention §13 forbids — authors never write the trailer and classification never depends on it.

This avoids P3 being pressed into service as the emergency escape hatch.

## Reclassification flow (P3)

- `deploy/<name>` → any of: `core`, `module/<name>`, `channel/<name>`, skill branch, adapter branch.
- Per-change, not per-commit. Commits are split where hunks belong to different homes.
- Follow-up plan reconciles the source branch after P2 has propagated the relocated change back.

## Merge mode (§5)

- Long-lived branches: `--no-ff` only. Squash forbidden. Fast-forward forbidden.
- Ephemeral branches: any mode; branch deleted on merge.
- Rationale: squash destroys history needed for future merges from the same source; FF erases the merge commit that marks class transitions.

**Enforcement boundary.** Squash merges leave a detectable marker (single-parent commit with a tree inconsistent with a direct edit over its parent); `check.ts` flags them. **Fast-forward cannot be detected post-hoc from history** — after an FF, the branch is indistinguishable from direct commits on that branch. FF prevention is therefore forge-level: branch protection on long-lived branches must require a PR with merge-commit strategy (GitHub "Require merge commit"; GitLab equivalent; self-hosted pre-receive hook). `merge-preserve.ts` is the local developer aid that prevents accidental FF on the workstation, not the enforcement layer.

## Inclusion = merge history

An edition "includes" a channel iff that channel is in the edition's ancestry. No manifest file. `cascade edition <name>` renders the inclusion set from the merge graph:

```
$ cascade edition starter
edition/starter  (version 1.9.0.2)
  core                          @ abc1234
  channels:
    whatsapp                    @ def5678
    telegram                    @ 9abc012
  skills:
    image-vision                @ 3def456
  adapters:
    reactions × whatsapp        @ 7890abc
```

Adding Slack to starter = merging `channel/slack` into `edition/starter`. The merge is the declaration.

## Deployment repository freedom (§12)

Deployments may live in the main repo, separate private repos, or a shared private repo with one branch per deployment. Cross-repo P2/P3 uses:

- An edition snapshot (`/.edition-snapshot.json`) shipped with the edition build, giving the deploy repo the information it needs to run P3 without a full branch graph.
- Patch handoff as the default cross-repo write path (emit `.patch` + metadata; human applies in parent repo).
- Forge-API PR creation as an opt-in for deployments that want automation.
