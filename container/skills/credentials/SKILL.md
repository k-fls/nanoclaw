---
name: credentials
description: Find available credentials, authenticate with external services, and guide users through credential setup. Use when the agent needs API keys, OAuth tokens, or login credentials for any service.
---

# Credentials & Authentication

## Credential layout

```
/workspace/group/credentials/
  keys/                ← own-scope credential manifest (what exists)
  tokens/              ← substitute tokens (ready to use)
  borrowed → granted/{grantor}/  ← active borrowed scope (symlink)
  granted/             ← manifests pushed by grantors (not usable until borrowed)
```

### Own credentials — keys and tokens

**Keys** list which credentials exist for this scope (no real tokens, no substitutes):

```bash
cat /workspace/group/credentials/keys/github.jsonl
```
```
{"provider":"github","name":"oauth","credScope":"my-group"}
```

**Tokens** contain substitute tokens ready for use:

```bash
cat /workspace/group/credentials/tokens/github.jsonl
```
```
{"provider":"github","name":"oauth","token":"ghp_RaNdOmFaKe..."}
```

Fields: `provider` (service ID), `name` (credential path — an arbitrary label for this credential within the provider), `token` (substitute — safe to use in env vars and HTTP requests; the host swaps it for the real token transparently). If `borrowed` is `true`, the credential comes from a shared scope.

### Multiple credentials per provider

A provider can have multiple named credentials (e.g. `oauth`, `deploy_key`, `staging_token` all under `github`). The `name` field is just a label — not a provider ID. Use `get_credential(providerId, credentialPath: "<name>")` to pull the substitute for a specific named credential. This enables per-use-case token isolation without adding new providers.

The name `oauth` is special — it's the default path where OAuth flows (device-code, token-exchange) store tokens and where automatic refresh looks. All other names are custom and must be managed manually via `/auth <provider>` commands.

### Borrowed credentials

Credential sharing is bilateral — a grantor pushes manifests, but the grantee must actively **borrow** from that grantor. The `borrowed` symlink points to the active grantor:

```bash
ls -l /workspace/group/credentials/borrowed
# borrowed -> granted/main-group/
```

Only credentials reachable through `borrowed/` are available. Check what's borrowed:

```bash
cat /workspace/group/credentials/borrowed/*.jsonl 2>/dev/null
```

Same format as keys — `{"provider","name","credScope"}`. The host generates substitute tokens for borrowed credentials on demand.

### Scanning all available credentials

```bash
# All ready-to-use tokens (own + borrowed with substitutes)
cat /workspace/group/credentials/tokens/*.jsonl

# All own-scope keys (may not have tokens yet)
cat /workspace/group/credentials/keys/*.jsonl 2>/dev/null

# All borrowed keys from the active grantor
cat /workspace/group/credentials/borrowed/*.jsonl 2>/dev/null
```

The substitute token works transparently — use it in HTTP headers, env vars, or CLI tools. The host proxy intercepts outbound HTTPS and swaps the substitute for the real credential.

## Supported providers

The host proxy knows about many OAuth providers. Per-provider info files describe what the proxy can do for each:

```bash
ls /workspace/global/credentials/providers/
cat /workspace/global/credentials/providers/github.jsonl
```

```
{"provider":"github","modes":["authorize-stub","bearer-swap","device-code","token-exchange"],"hosts":["api.github.com","github.com"],"envVars":{"GH_TOKEN":"oauth","GITHUB_TOKEN":"oauth"}}
```

### Fields

- **`provider`** — service identifier (matches the token file name in `credentials/tokens/`)
- **`modes`** — proxy capabilities for this provider:
  - `device-code` — proxy intercepts device-code responses and notifies the user with the verification URL and code. **Preferred auth method** — the agent initiates the flow, the user completes it on their side. Agent should not to inform user for this provider as it is handled automatically.
  - `authorize-stub` — proxy intercepts browser OAuth redirects and handles the flow with the user. The agent gets a JSON stub response instead of the real redirect and can use provided SSE endpoint from the page to track progress.
  - `bearer-swap` — proxy transparently replaces substitute tokens with real ones in Authorization headers on outbound API requests. This is what makes substitute tokens work. Presense of this mode indicates that credentials for this provider can be safely handled as through /auth command.
  - `token-exchange` — proxy intercepts OAuth token exchange requests, stores the real tokens, and returns substitutes to the container.
- **`hosts`** — domains the proxy intercepts for this provider. API calls to these hosts will have substitute tokens swapped automatically.
- **`envVars`** — env var name to credential path mapping. When credentials exist, these env vars are set with substitute tokens at container startup.

### Checking provider support

To list all supported providers:
```bash
ls /workspace/global/credentials/providers/*.jsonl | sed 's/.*\///' | sed 's/\.jsonl//'
```

To check if a specific service supports device-code auth:
```bash
grep device-code /workspace/global/credentials/providers/<provider>.jsonl
```

To check if a domain is covered by any provider:
```bash
grep '<domain>' /workspace/global/credentials/providers/*.jsonl
```

## Pulling substitute tokens at runtime

Use `get_credential` **only** when a credential appears in `keys/` or `borrowed/` but has no entry in `tokens/`. This means the key exists but no substitute token has been generated yet — typically because the credential was added after container startup or a borrowed credential hasn't been activated.

If the credential already has an entry in `tokens/`, just use that token directly — do not call `get_credential`.

```
get_credential(providerId: "github", credentialPath: "oauth")
get_credential(providerId: "todoist", credentialPath: "api_key")
```

Both parameters are required. Check the provider's `.jsonl` file in `/workspace/global/credentials/providers/` to find the correct `credentialPath` — it's listed in the `envVars` mapping (e.g. `{"GH_TOKEN":"oauth"}` means the path is `"oauth"`).

The tool returns the substitute token and any env var mappings. Export the returned env vars in your shell to use them for the rest of the session.

**When to use this:**
- Credential in `keys/` but not in `tokens/` (added mid-session via `/auth`)
- Credential in `borrowed/` but not in `tokens/` (grantor added or updated a credential)

## When a credential is missing

Follow this priority order:

### 1. Device-code OAuth (preferred)

Check if the provider supports `device-code` mode:
```bash
grep device-code /workspace/global/credentials/providers/<provider>.jsonl
```

If supported:

1. Inform the user via SendMessage that you are initiating authentication
2. Start the device-code flow (e.g. `gh auth login` or the service's CLI)
3. The host proxy intercepts the device-code response and notifies the user with the verification URL and code
4. The user completes authentication on their device
5. Once complete, the credential appears in `/workspace/group/credentials/tokens/`

### 2. Browser-based OAuth

If the provider supports `authorize-stub` but not `device-code`:

1. Initiate the OAuth flow (open the authorization URL via the service's CLI or HTTP request)
2. The host proxy intercepts the authorization request and returns a JSON stub:
   ```json
   {"status":"intercepted","message":"...","url":"https://...","interactionId":"github:0:abc123","statusUrl":"/interaction/github%3A0%3Aabc123/status","eventsUrl":"/interaction/github%3A0%3Aabc123/events"}
   ```
3. If you get this stub response, the host is handling the OAuth flow directly with the user. Use `statusUrl` to poll for completion (see "Tracking interaction status" below) or `eventsUrl` to track progress (SSE stream).
4. If you get a different response (actual HTML page, redirect, or error), the provider is **not supported** by the host proxy. Tell the user:
   - This service's OAuth is not yet configured in NanoClaw
   - Ask them to report this app/service to the NanoClaw admin
   - Do NOT ask the user to provide login credentials directly

### 3. Manual key via /auth command

If the service does not support OAuth and requires an API key or token passed via env var or HTTP header:

1. Tell the user to use the `/auth` command in their chat to add the key:
   - `/auth <provider>` — interactive GPG-encrypted key setup
   - `/auth <provider> set-key <PGP-encrypted-block>` — non-interactive
2. The user encrypts the key with GPG and sends it through the chat
3. Once stored, the safe substitute appears in `/workspace/group/credentials/tokens/`
4. Use the substitute from the provider's `.jsonl` file in your requests

**Never ask users to paste raw API keys or passwords directly into the chat.**

## Tracking interaction status

When an OAuth flow is initiated, the proxy returns an `interactionId`. Use it to track progress.

### Simple status check (polling)

```bash
curl -s -o /dev/null -w '%{http_code}' http://${PROXY_HOST}:${PROXY_PORT}/interaction/<interactionId>/status
```

HTTP status codes:
- **202** — in progress (queued or active, user is being prompted)
- **200** — completed (credentials are ready)
- **410** — failed or superseded (check the message)
- **404** — interaction is unknown or was completed and pruned

Full response with message:
```bash
curl -s http://${PROXY_HOST}:${PROXY_PORT}/interaction/<interactionId>/status
```

Returns: `{"state":"active","message":"presenting to user"}` or `{"state":"removed","message":"superseded by github:0:newerHash"}`

### SSE stream (live updates)

For real-time progress, connect to the SSE endpoint:
```bash
curl -N http://${PROXY_HOST}:${PROXY_PORT}/interaction/<interactionId>/events
```

Events are streamed as they happen: `queued` → `active` → `completed` or `failed`.

### List all interactions

```bash
curl -s http://${PROXY_HOST}:${PROXY_PORT}/interactions
```

Returns a JSON array of all tracked interactions with their current state.

### Superseded interactions

When a newer OAuth flow starts for the same provider, older interactions are automatically removed with state `removed` and message `superseded by <newInteractionId>`. If you get a 410 with a superseded message, use the new interactionId from the message.
