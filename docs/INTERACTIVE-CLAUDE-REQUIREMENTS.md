# Running Claude CLI Interactively in a Container

How to run `claude` CLI interactively inside a Docker container and drive it programmatically.

## 1. PTY Allocation

Claude CLI requires a real terminal (PTY) for interactive mode. Use Python's `pty.fork()` to allocate a PTY and drive it programmatically:

```python
import pty, os
pid, fd = pty.fork()
if pid == 0:
    os.environ['COLUMNS'] = '500'
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('claude', ['claude'])
```

The `script -qc 'claude' /dev/null` approach also works but doesn't allow programmatic input timing (needed for dialog navigation).

## 2. `$HOME/.claude.json`

Claude enters an infinite onboarding loop if this file is missing. It lives at `$HOME/.claude.json` — sibling to `.claude/`, not inside it.

Required fields to skip all onboarding prompts:

```json
{
  "numStartups": 5,
  "hasCompletedOnboarding": true,
  "autoUpdates": false,
  "skipAutoPermissionPrompt": true,
  "skipDangerousModePermissionPrompt": true
}
```

| Field | Why |
|-------|-----|
| `numStartups > 0` | Skips theme picker |
| `hasCompletedOnboarding` | Skips onboarding wizard |
| `autoUpdates: false` | Prevents update check hanging |
| `skipAutoPermissionPrompt` | Skips "auto mode" confirmation dialog |
| `skipDangerousModePermissionPrompt` | Skips "bypass permissions" confirmation dialog |

This file is ephemeral — it must be created before each run if the home directory is not persisted.

## 3. `$HOME/.claude/settings.json`

Must include a `permissions.defaultMode` that doesn't require interactive confirmation:

```json
{
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)"],
    "defaultMode": "auto"
  }
}
```

Do NOT use `"bypassPermissions"` — it triggers an extra confirmation dialog even with `skipDangerousModePermissionPrompt`, depending on the version.

## 4. `$HOME/.claude/.credentials.json`

Claude reads OAuth credentials from this file:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1774709967634
  }
}
```

If the access token is expired (`expiresAt` < now), Claude triggers a refresh via `POST https://platform.claude.com/v1/oauth/token` using the refresh token.

After a successful refresh, Claude writes the new tokens back to this file.

## 5. No competing credential env vars

Claude prefers env vars over `.credentials.json`:
- `CLAUDE_CODE_OAUTH_TOKEN` — if set, Claude uses this instead of reading from file
- `ANTHROPIC_API_KEY` — if set, Claude uses API key auth instead of OAuth

For interactive mode with real credentials, these must be unset:
```bash
unset CLAUDE_CODE_OAUTH_TOKEN
unset ANTHROPIC_API_KEY
```

## 6. Trust dialog navigation

Even with all settings above, Claude shows a "trust this folder" dialog on first run in a new workspace. The PTY driver must navigate it programmatically:

1. Wait for text matching `trust` or `Enter to confirm` (up to 30s)
2. Send `\r` (Enter) to confirm
3. Send additional `\r` keypresses to dismiss any remaining prompts (auto mode opt-in, etc.)
4. Wait for the input prompt (`❯`) before sending the actual message

The dialog sequence observed (Claude Code v2.1.85):
1. Theme picker — skipped by `numStartups > 0`
2. "Trust this folder?" — requires Enter
3. Auto mode / bypass permissions opt-in — skipped by `settings.json` + `.claude.json` flags
4. Input prompt (`❯`) — ready for input

## 7. Container image

The container must have `@anthropic-ai/claude-code` installed globally:
```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

