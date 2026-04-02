# Claude Integration into Universal OAuth System

## Context

Claude currently uses its own hardcoded handlers (`handleApiHost`, `handleOAuthTokenExchange`) with static `PLACEHOLDER_*` constants. The universal OAuth system (discovery-file-driven, format-preserving substitutes, scoped token engine) is built but Claude doesn't use it. This plan migrates Claude to the universal system and generalizes the browser shim for all providers.

## Current Claude Flow (what we're replacing)

1. **Auth containers**: Spawn interactive `claude auth login` or `claude setup-token`, scrape stdout for OAuth URL, poll `.oauth-url` file, relay URL to user via chat, deliver callback
2. **Agent containers**: Inject `PLACEHOLDER_*` env vars + `.credentials.json` with placeholders. `handleApiHost` swaps placeholders with real tokens from encrypted credential store. `handleOAuthTokenExchange` swaps placeholder refresh tokens and stores new real tokens.
3. **Refresh**: Either Claude CLI refreshes internally (requires interactive mode) or `claudeProvider.refresh()` spawns an entire container just to trigger refresh — 30s overhead
4. **Auth errors**: `authGuard` detects 401 from agent output, tries refresh, falls back to interactive reauth

## New Flow

### 1. Universal Browser Shim

**New proxy endpoint**: `POST /_auth/browser-open`

The xdg-open shim in containers calls this instead of writing to a file.

**Shim** (`container/shims/xdg-open`):
```sh
#!/bin/sh
RESULT=$(curl -sf -X POST \
  "http://$PROXY_HOST:$PROXY_PORT/_auth/browser-open" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$1\"}")
EXIT_CODE=$(echo "$RESULT" | sed -n 's/.*"exit_code":\([0-9]*\).*/\1/p')
exit ${EXIT_CODE:-1}
```

**Endpoint logic** (`src/auth/browser-open-handler.ts`):
1. Extract `url` from request body
2. Identify caller scope from container IP
3. Match URL against known `authorization_endpoint` patterns (from discovery files)
4. Decision:
   - **Known provider**: Return `{ exit_code: 0 }`. Extract `redirect_uri` from the URL (the container's localhost callback port). Relay the OAuth URL to the user via the messaging channel. Store the callback port so the host can deliver the callback when the user provides it.
   - **Unknown URL**: Return `{ exit_code: 1 }` (error — container tool sees "browser failed")
   - **Future**: `{ exit_code: 0, replacement_url: "..." }` for proxy-mediated OAuth where the proxy rewrites redirect_uri to itself

**Mount shim in all containers** — both auth and agent containers. Any tool (GitHub CLI, gcloud, Slack CLI, etc.) can trigger OAuth. `claude -p` never calls xdg-open, so the shim is irrelevant for Claude in agent containers but needed for other tools the agent may invoke.

**Modified**: `container-runner.ts` — mount xdg-open shim (currently only in auth containers via `exec.ts`).

### 2. Token Exchange via Universal Handler

Replace `handleOAuthTokenExchange` with the universal token-exchange handler.

When Claude CLI (or any tool) hits the token endpoint:
- **Outbound**: Substitute refresh token → real refresh token (from TokenResolver via handle)
- **Inbound**: Real access/refresh tokens → store in TokenResolver, generate format-preserving substitutes, return to container
- **Side effect**: Also update the encrypted credential store (so tokens survive restarts)

The encrypted credential store (`credentials/{scope}/claude_auth.json`) remains the source of truth for persistence. `InMemoryTokenResolver` is the runtime cache. On restart, `provision()` reads from the encrypted store and the container-runner generates fresh substitutes.

### 3. Bearer-swap via Universal Handler

Replace `handleApiHost` with the universal bearer-swap handler, with one Claude-specific extension:

**Two header modes**:
- `Authorization: Bearer <substitute>` → standard bearer-swap (OAuth mode)
- `x-api-key: <substitute>` → API key swap (API key mode)

Detection: check which header is present on the request. No state lookup needed.

**401/403 handling by auth mode**:
- **OAuth mode**: Apply refresh strategy (307 redirect or passthrough-with-hold). The proxy refreshes the real token behind the substitute, then retries.
- **API key mode**: Do NOT attempt refresh. Pass the 401 through immediately. API keys don't refresh — auth errors escalate to the user via the existing `authGuard.handleAuthError` path.

### 4. Container Startup (credential provisioning)

**Modified**: `container-runner.ts`

Instead of injecting `PLACEHOLDER_*` constants:
1. `claudeProvider.provision(scope)` → real tokens from encrypted store
2. `tokenEngine.generateSubstitute(realToken, ...)` → format-preserving substitute
3. Inject substitute into container env (`ANTHROPIC_API_KEY=<sub>` or `CLAUDE_CODE_OAUTH_TOKEN=<sub>`)
4. For OAuth mode: write `.credentials.json` with substitute access + refresh tokens (CLI reads this for in-band refresh)

The substitutes look like real tokens (same prefix, delimiters, length) so SDKs that validate format won't reject them.

### 5. Refresh Flow (replaces container-spawn refresh)

**Before**: `claudeProvider.refresh()` spawns an interactive Claude container, sends `"reply: hi"`, waits for output — 30s overhead.

**After**: Transparent proxy-level refresh:
1. Claude CLI sends API request with expired substitute access token
2. Proxy swaps to real (expired) access token, upstream returns 401
3. Bearer-swap handler detects 401, applies refresh strategy:
   - **307 redirect**: Proxy calls `credProvider.refresh()` which hits the token endpoint, gets new tokens, stores them. Sends 307 to container. CLI re-sends with same substitute, proxy swaps with fresh real token. 200.
   - **Passthrough-with-hold (fallback)**: If 307 doesn't work with Claude SDK, hold the 401, refresh, pass 401 through. CLI's next request gets fresh token.
4. Alternatively: CLI itself sends `grant_type=refresh_token` to token endpoint → universal token-exchange handler swaps substitute refresh token → gets new tokens → returns new substitutes to CLI. Fully transparent.

`claudeProvider.refresh()` can be simplified to just hit the token endpoint directly (HTTP request) instead of spawning a container.

### 6. Callback Delivery

When the shim endpoint receives an OAuth URL and returns exit 0:

1. Proxy extracts `redirect_uri` parameter → gets localhost callback port
2. Proxy relays the OAuth URL to the user via internal event → messaging channel
3. User opens URL in their browser, completes authorization
4. Browser redirects to `http://localhost:PORT/callback?code=...&state=...` — this fails (user's machine can't reach container's localhost)
5. User copies the URL from browser address bar, pastes in chat
6. Host receives the URL, extracts code/state, delivers callback to container's localhost:PORT via `fetch()`

This is the same relay mechanism as today but triggered by the proxy endpoint instead of file polling. The `detectCodeDelivery` / `callbackHandler` logic in `claude.ts` is reusable — it just gets a cleaner trigger.

## Auth Mode Summary

| Mode | Header | Substitute format | 401 behavior | Refresh |
|------|--------|-------------------|--------------|---------|
| API key | `x-api-key` | `sk-ant-api*` | Pass through, escalate to user | None |
| OAuth (setup-token) | `Authorization: Bearer` | `sk-ant-oat*` | 307 redirect or hold | Via token endpoint |
| OAuth (auth-login) | `Authorization: Bearer` | `sk-ant-oat*` | 307 redirect or hold | Via token endpoint |

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `container/shims/xdg-open` | modify | Call proxy endpoint instead of writing file |
| `src/auth/browser-open-handler.ts` | new | Proxy endpoint for browser-open decisions |
| `src/auth/universal-oauth-handler.ts` | modify | Add x-api-key header support, auth-mode-aware 401 handling |
| `src/container-runner.ts` | modify | Generate substitutes instead of PLACEHOLDER_*, mount shim |
| `src/credential-proxy.ts` | modify | Add /_auth/browser-open endpoint |
| `src/auth/providers/claude.ts` | modify | Remove handleApiHost, handleOAuthTokenExchange, simplify refresh() |
| `src/auth/registry.ts` | modify | Wire Claude's token endpoint/API host through universal handlers |

## Not Changed

- Encrypted credential store — remains the persistent source of truth
- `authGuard` — still handles escalation for API key 401s and OAuth failures
- `reauth.ts` — interactive reauth menu stays as fallback
- `provision.ts` — scope resolution unchanged

## Implementation Order

1. Browser-open proxy endpoint + shim update
2. Mount shim in agent containers (`container-runner.ts`)
3. Migrate token-exchange to universal handler (wire Anthropic token endpoint through discovery)
4. Migrate bearer-swap to universal handler (with x-api-key support)
5. Update container-runner to generate substitutes instead of PLACEHOLDER_*
6. Simplify `claudeProvider.refresh()` (remove container-spawn)
7. Test 307 compatibility with Claude SDK, implement fallback if needed
8. Remove dead code (handleApiHost, handleOAuthTokenExchange, PLACEHOLDER_* constants, file-polling detection)
