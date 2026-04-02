# Remote SSH Control Without Credential Exposure

## Context

NanoClaw agents (Claude in containers) need to control remote Docker hosts and VMs via SSH — execute commands, transfer files, view logs, install apps from git. **Claude must never see SSH keys or passwords.** The existing credential proxy MITM's HTTPS for API keys, but SSH isn't HTTP. We use `ssh2` library to manage persistent SSH sessions on the host, exposed as MCP tools to the container agent.

## Architecture

```
Container (Claude)                    Host (NanoClaw process)
┌─────────────────┐                  ┌──────────────────────────────┐
│ MCP tools:       │  HTTP to proxy  │ credential-proxy.ts          │
│  ssh_connect()   │ ──────────────→ │  /ssh/connect → ssh2 Client  │
│  ssh_bash()      │ ──────────────→ │  /ssh/exec    → client.exec()│
│  ssh_put/get()   │ ──────────────→ │  /ssh/put,get → SFTP         │
│  ssh_close()     │ ──────────────→ │  /ssh/close   → client.end() │
│                  │  JSON response  │                              │
│  ← result       │ ←────────────── │  SSH session pool (in-memory)│
└─────────────────┘                  │  Credentials: encrypted store│
                                     └──────────┬───────────────────┘
                                                │ ssh2
                                     ┌──────────▼──────────┐
                                     │ Remote hosts / VMs   │
                                     └─────────────────────┘
```

## Agent Workflow

```
session = ssh_connect(host="192.168.1.10")       → { session_id: "abc123" }
result  = ssh_bash(session="abc123", command="cd /opt/app && git pull")  → { stdout, stderr, exit_code }
result  = ssh_bash(session="abc123", command="docker compose up -d")     → { stdout, stderr, exit_code }
         ssh_put(session="abc123", local="/workspace/config.yml", remote="/opt/app/config.yml")
         ssh_close(session="abc123")
```

- Persistent sessions: one `ssh2.Client` per `ssh_connect`, reused across `ssh_bash` calls
- No re-authentication per command — same connection, shared state (cd, env vars persist within a single exec, but each exec is independent like regular SSH)
- Multiple concurrent sessions supported (different hosts or same host)
- Auto-close after idle timeout (5 min)

## Implementation

### Phase 1: SSH session manager on the host

**New file: `src/remote/ssh-pool.ts`** — Core session management
- `SshSessionPool` class:
  - `connect(host, port, user, privateKey): string` — create `ssh2.Client`, return session_id
  - `exec(sessionId, command, timeout?): { stdout, stderr, exitCode }` — `client.exec()`
  - `sftpPut(sessionId, localPath, remotePath)` — `client.sftp()` + write stream
  - `sftpGet(sessionId, remotePath, localPath)` — `client.sftp()` + read stream
  - `close(sessionId)` — `client.end()`, remove from pool
  - Idle timeout: 5 min, auto-close with `setTimeout` reset on each operation
  - Max output buffer: 1MB per exec, truncate with warning
  - Session map: `Map<string, { client: ssh2.Client, scope: string, host: string, timer: NodeJS.Timeout }>`
  - Session IDs: `crypto.randomUUID()`

**New file: `src/remote/host-config.ts`** — Host-to-credential mapping
- `loadHostsConfig()` — reads `~/.config/nanoclaw/remote-hosts.json`
- `matchHost(address): { user, port, credentialKey }` — glob pattern match
- Config format:
  ```json
  {
    "hosts": [
      { "pattern": "192.168.*", "user": "deploy", "port": 22, "credentialKey": "deploy_key" },
      { "pattern": "*.prod.example.com", "user": "admin", "credentialKey": "prod_key" }
    ]
  }
  ```

**New file: `src/remote/types.ts`** — Type definitions
- `SshConnectRequest`: `{ host, port? }`
- `SshExecRequest`: `{ session_id, command, timeout? }`
- `SshTransferRequest`: `{ session_id, local_path, remote_path }`
- `SshSession`: internal session state type

**New file: `src/remote/handlers.ts`** — HTTP request handlers
- `handleSshConnect(req, res, scope)` — match host config, decrypt SSH key, create session
- `handleSshExec(req, res, scope)` — validate session belongs to scope, exec command
- `handleSshPut(req, res, scope)` / `handleSshGet(req, res, scope)` — SFTP operations
- `handleSshClose(req, res, scope)` — close session

### Phase 2: SSH credential provider

**New file: `src/auth/providers/ssh.ts`** — CredentialProvider implementation
- `service: 'ssh_remote'`, follows same pattern as `src/auth/providers/claude.ts`
- `provision(scope)`: returns `{ env: {} }` — no env vars injected (keys stay on host)
- `storeResult(scope, result)`: encrypts SSH private key via `src/auth/store.ts`
- Credential stored at: `~/.config/nanoclaw/credentials/{scope}/ssh_{credentialKey}.json`
- `loadSshKey(scope, credentialKey)`: decrypt + return key for `ssh2.Client.connect()`

**Auth options (same GPG pattern as Claude API key in `src/auth/providers/claude.ts:871`):**

1. **GPG-encrypted paste via chat** (primary, reuses existing GPG infra):
   - `ensureGpgKey(scope)` creates per-scope GPG keypair (`src/auth/gpg.ts`)
   - Agent sends public key to user
   - User encrypts SSH private key locally: `cat ~/.ssh/id_ed25519 | gpg --encrypt --armor --recipient nanoclaw`
   - User pastes PGP message in chat
   - `isPgpMessage()` detects it, `gpgDecrypt(scope, ciphertext)` recovers plaintext
   - `encrypt()` (AES-256-GCM) + `saveCredential()` stores it
   - Key never visible in plaintext in chat

2. **Generate new keypair** (cleanest for new setups):
   - NanoClaw generates ed25519 keypair using `ssh2` or Node.js `crypto`
   - Private key encrypted + stored
   - Public key shown to user: "Add this to `authorized_keys` on your remote hosts"
   - No existing key exposure at all

**Scope model:**
- Each scope/group can have its own SSH keys (stored under `credentials/{scope}/ssh_*.json`)
- Groups can be granted access to global keys (stored under `credentials/default/ssh_*.json`)
- `resolveScope()` from `src/auth/provision.ts` handles fallback: group-specific → default

**Modify: `src/auth/index.ts`** — register SSH provider in `registerBuiltinProviders()`

### Phase 2b: Host configuration

**Config file:** `~/.config/nanoclaw/remote-hosts.json` (manual editing for bulk setup)

**Interactive setup via chat** (for adding individual hosts):
- User: "add my server 192.168.1.10"
- Agent asks for SSH user, which stored key to use
- Writes to config file via IPC or direct file write

**Per-scope host access:**
- Each host entry has optional `allowedScopes` (default: `["*"]` = all groups)
- Groups see only hosts they're allowed to connect to

### Phase 3: Wire into credential proxy

**Modify: `src/credential-proxy.ts`** — add `/ssh/*` routes in HTTP server handler
```typescript
// After /health check, before proxy logic:
if (req.url?.startsWith('/ssh/')) {
  const scope = this.validateCaller(req.socket.remoteAddress);
  if (!scope) { res.writeHead(403); res.end('Forbidden'); return; }
  handleSshRoute(req, res, scope);
  return;
}
```
- Import handlers from `src/remote/handlers.ts`
- Session pool instantiated once, passed to handlers

### Phase 4: Container MCP tools

**Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`** — add SSH tools:

| Tool | Description | Input |
|------|-------------|-------|
| `ssh_connect` | Open persistent SSH session to a remote host | `{ host: string, port?: number }` |
| `ssh_bash` | Execute command on an open SSH session | `{ session_id: string, command: string, timeout?: number }` |
| `ssh_put` | Upload file to remote host via SFTP | `{ session_id: string, local_path: string, remote_path: string }` |
| `ssh_get` | Download file from remote host via SFTP | `{ session_id: string, remote_path: string, local_path: string }` |
| `ssh_close` | Close an SSH session | `{ session_id: string }` |

Each tool makes HTTP POST to `http://${PROXY_HOST}:${PROXY_PORT}/ssh/<action>`.

**Modify: `container/agent-runner/src/index.ts`** — add `mcp__nanoclaw__ssh_*` to `allowedTools`

### Phase 5: Cleanup and lifecycle

- On container exit: close all sessions for that scope (host-side, triggered by container-runner)
- On NanoClaw shutdown: close all sessions gracefully
- `getActiveSessions(scope?)` method for debugging/monitoring

## Security

| Concern | Mitigation |
|---------|-----------|
| Key exposure to LLM | Keys never enter container; decrypted only in host process for `ssh2.Client` |
| Arbitrary host access | Only hosts matching patterns in `remote-hosts.json` are connectable |
| Session hijacking | Session IDs are UUIDs; validated against scope (container IP → scope) |
| Output bomb | 1MB max stdout/stderr per exec; truncated with warning |
| Timeout | 60s default per command; `ssh2` exec timeout + process-level fallback |
| Idle sessions | Auto-close after 5 min idle; cleaned up on container exit |
| SFTP path traversal | Validate paths are within allowed directories (if configured) |

## Files Summary

| Action | File |
|--------|------|
| **Create** | `src/remote/types.ts` |
| **Create** | `src/remote/ssh-pool.ts` |
| **Create** | `src/remote/host-config.ts` |
| **Create** | `src/remote/handlers.ts` |
| **Create** | `src/auth/providers/ssh.ts` |
| **Modify** | `src/credential-proxy.ts` — add `/ssh/*` routing |
| **Modify** | `src/auth/index.ts` — register SSH provider |
| **Modify** | `container/agent-runner/src/ipc-mcp-stdio.ts` — add SSH MCP tools |
| **Modify** | `container/agent-runner/src/index.ts` — allowedTools |

## Dependencies

- `ssh2` npm package (pure JS SSH2 implementation)

## Verification

1. **Unit tests**: host pattern matching, session pool lifecycle, idle timeout cleanup
2. **Integration tests**: HTTP handler chain with mocked `ssh2.Client`
3. **Manual E2E**: Configure a test host, store SSH key, ask Claude "connect to 192.168.1.10 and run `uptime`" — verify it uses `ssh_connect` + `ssh_bash`, gets result, key never appears in conversation
