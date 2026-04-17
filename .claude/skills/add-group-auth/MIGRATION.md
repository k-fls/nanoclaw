# Migrating group-auth to branch-based format

The old skills-engine format (`add/`, `modify/`, `manifest.yaml`, `.intent.md`) is replaced by plain git branches. The skill branch IS the codebase with group-auth applied. Users install with `git merge`.

## Steps

### 1. Create the skill branch

```bash
git checkout -b skill/group-auth upstream/main
```

### 2. Move `add/` files to their real paths

Files under `add/` go directly into the repo:

| Old path | New path |
|---|---|
| `add/src/auth/types.ts` | `src/auth/types.ts` |
| `add/src/auth/store.ts` | `src/auth/store.ts` |
| `add/src/auth/store.test.ts` | `src/auth/store.test.ts` |
| `add/src/auth/registry.ts` | `src/auth/registry.ts` |
| `add/src/auth/registry.test.ts` | `src/auth/registry.test.ts` |
| `add/src/auth/exec.ts` | `src/auth/exec.ts` |
| `add/src/auth/gpg.ts` | `src/auth/gpg.ts` |
| `add/src/auth/gpg.test.ts` | `src/auth/gpg.test.ts` |
| `add/src/auth/guard.ts` | `src/auth/guard.ts` |
| `add/src/auth/provision.ts` | `src/auth/provision.ts` |
| `add/src/auth/provision.test.ts` | `src/auth/provision.test.ts` |
| `add/src/auth/reauth.ts` | `src/auth/reauth.ts` |
| `add/src/auth/reauth.test.ts` | `src/auth/reauth.test.ts` |
| `add/src/auth/index.ts` | `src/auth/index.ts` |
| `add/src/auth/providers/claude.ts` | `src/auth/providers/claude.ts` |
| `add/src/auth/providers/claude.test.ts` | `src/auth/providers/claude.test.ts` |
| `add/container/shims/xdg-open` | `container/shims/xdg-open` |

### 3. Apply `modify/` files over core

Files under `modify/` are the full modified versions of core files. Copy each one over the original on the branch:

| Old path | Replaces |
|---|---|
| `modify/src/config.ts` | `src/config.ts` |
| `modify/src/container-runner.ts` | `src/container-runner.ts` |
| `modify/src/credential-proxy.ts` | `src/credential-proxy.ts` |
| `modify/src/credential-proxy.test.ts` | `src/credential-proxy.test.ts` |
| `modify/src/index.ts` | `src/index.ts` |
| `modify/src/types.ts` | `src/types.ts` |

### 4. Apply structured operations

From `manifest.yaml`, do these manually on the branch:

- Add `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` to `.env.example`
- Run `chmod +x container/shims/xdg-open`

### 5. Delete old-format artifacts

Remove from the branch:

- `manifest.yaml`
- All `.intent.md` files (`modify/src/*.intent.md`)
- The entire `.claude/skills/add-group-auth/add/` directory (files already moved)
- The entire `.claude/skills/add-group-auth/modify/` directory (files already applied)

### 6. Update SKILL.md

Replace Phase 2 ("Apply Code Changes"). Remove all references to:

- `scripts/apply-skill.ts`
- `.nanoclaw/state.yaml`
- Intent files

Phase 2 becomes:

```markdown
## Phase 2: Apply Code Changes

### Merge the skill branch

git fetch origin skill/group-auth
git merge origin/skill/group-auth

If merge conflicts occur, resolve them. The skill adds/modifies:
- `src/auth/` module (types, store, registry, exec, gpg, guard, provision, reauth, providers)
- `container/shims/xdg-open` (blocks browser opening for console-friendly OAuth)
- `src/config.ts`, `src/container-runner.ts`, `src/credential-proxy.ts`, `src/index.ts`, `src/types.ts`
- `.env.example` — adds `NEW_GROUPS_USE_DEFAULT_CREDENTIALS`

### Post-merge

npm install
chmod +x container/shims/xdg-open

### Validate

npm run build
npx vitest run src/auth/
```

Also update Phase 1 — replace the `.nanoclaw/state.yaml` check with:

```bash
git log --merges --oneline | grep -i group-auth
```

### 7. Commit and push

```bash
git add -A
git commit -m "skill/group-auth: per-group encrypted credential system"
git push origin skill/group-auth
```

### 8. Add to marketplace

See the marketplace section below.

## Marketplace publishing

There are two options for making the skill discoverable.

### Option A: Add to the shared upstream marketplace

The upstream marketplace (`qwibitai/nanoclaw-skills`) bundles all official skills. To add group-auth:

1. Fork/clone `qwibitai/nanoclaw-skills`
2. Add `plugins/nanoclaw-skills/skills/add-group-auth/SKILL.md` — this is the setup-instructions-only SKILL.md (step 1 = merge the branch, then interactive setup)
3. Open a PR to `qwibitai/nanoclaw-skills`

Once merged, all NanoClaw users who have installed the marketplace plugin (`claude plugin install nanoclaw-skills@nanoclaw-skills`) will see `/add-group-auth` in their available skills. No config change needed — the skill is bundled into the existing plugin.

**When to use this:** When the skill is generally useful and you want it available to all NanoClaw users through `/setup` and `/customize`.

### Option B: Create your own marketplace

You can maintain your own marketplace repo with your own skills. This gives you full control over publishing and doesn't require upstream approval.

1. Create a marketplace repo (e.g., `k-fls/nanoclaw-skills`) with this structure:

```
k-fls/nanoclaw-skills/
  .claude-plugin/
    marketplace.json
  plugins/
    k-fls-skills/
      .claude-plugin/
        plugin.json
      skills/
        add-group-auth/
          SKILL.md
```

2. `marketplace.json` registers the plugin catalog:

```json
{
  "plugins": {
    "k-fls-skills": {
      "name": "k-fls NanoClaw Skills",
      "description": "Custom NanoClaw skills"
    }
  }
}
```

3. `plugin.json` declares the plugin:

```json
{
  "name": "k-fls-skills",
  "description": "Custom NanoClaw skills by k-fls",
  "skills": ["add-group-auth"]
}
```

4. The skill branch (`skill/group-auth`) lives on YOUR fork (`k-fls/nanoclaw`), not upstream. The SKILL.md points users to your remote:

```bash
git remote add k-fls https://github.com/k-fls/nanoclaw.git
git fetch k-fls skill/group-auth
git merge k-fls/skill/group-auth
```

### Registering your marketplace

To make it auto-discovered by all NanoClaw users, PR this into upstream's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": { "..." : "..." },
    "k-fls-nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "k-fls/nanoclaw-skills"
      }
    }
  }
}
```

Users can also add it manually without upstream approval:

```bash
claude plugin install k-fls-skills@k-fls-nanoclaw-skills --scope project
```

### Which option to pick

| | Shared marketplace | Your own marketplace |
|---|---|---|
| Approval needed | Yes (PR to upstream) | No |
| Discoverable by all users | Automatically | Only if registered or manually added |
| Skill branch lives on | `qwibitai/nanoclaw` | Your fork |
| CI merge-forward | Upstream maintains | You maintain |
| Best for | Generally useful skills | Personal/org-specific skills |
