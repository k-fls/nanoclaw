# Multi-Git: Per-Folder GitHub Authentication

Use different GitHub accounts/tokens per repository folder, fully automatic with no manual switching.

## How It Works

1. Each GitHub account is stored as a named credential under the `github` provider (e.g. `oauth`, `geosafe`, `altreo`)
2. `~/.gitconfig.d/config` maps folders to per-account credential configs via `includeIf`
3. Git credential helper outputs the right substitute token for that folder
4. Proxy sees the substitute in the request and swaps it for the correct real token transparently

`GIT_CONFIG_GLOBAL=~/.gitconfig.d/config` is set persistently via `/workspace/group/env-custom.jsonl`.

## File Layout

```
~/.gitconfig.d/
  config          ← global config with includeIf rules (persistent)
  <name>          ← credential config per account (one file per account)
```

`~/.gitconfig.d/` is a persistent home subfolder — survives container restarts.

## Adding a New Account

### 1. Store the credential

User runs `/auth github` and stores the token under a custom name (e.g. `work`).
Token appears in `/workspace/group/credentials/keys/github.jsonl` with name `work`,
and the substitute in `/workspace/group/credentials/tokens/github.jsonl` as a new line.

Read the substitute directly from the tokens file:
```bash
TOKEN=$(node -e "
const fs=require('fs');
const lines=fs.readFileSync('/workspace/group/credentials/tokens/github.jsonl','utf8').trim().split('\n');
const entry=lines.map(l=>JSON.parse(l)).find(e=>e.name==='work');
console.log(entry.token);
")
```

If the token isn't in the file yet (credential added mid-session), use `get_credential`:
```
get_credential(providerId: "github", credentialPath: "work")
```

### 2. Add includeIf rule to global config

```bash
cat >> ~/.gitconfig.d/config << 'EOF'

[includeIf "gitdir:/workspace/extra/<folder>/"]
    path = ~/.gitconfig.d/<name>
EOF
```

### 3. Create per-account credential config

```bash
cat > ~/.gitconfig.d/<name> << EOF
[credential "https://github.com"]
    helper = !echo username=git; echo password=${TOKEN}
EOF
```

### 4. Verify

```bash
cd /workspace/extra/<folder>/some-repo
git config credential.helper   # should show the echo helper for this folder
```

## Notes

- `github` is a single provider — multiple accounts are just multiple named credentials within it, not separate providers
- Each named credential has its own substitute token; the proxy resolves the correct real token by looking up whichever substitute it sees in the request
- `includeIf "gitdir:..."` requires a trailing slash on the path
