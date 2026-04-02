# Universal OAuth Integration — Status & Remaining Work

## What Was Done

### 1. Browser-open proxy endpoint

**Files**: `src/auth/browser-open-handler.ts`, `src/credential-proxy.ts`, `container/shims/xdg-open`

The xdg-open shim in containers now calls `POST /auth/browser-open` on the credential proxy instead of writing to a file. The endpoint:
- Matches the URL against registered `authorization_endpoint` patterns (from discovery files and Claude's programmatic registration)
- Known OAuth URL → `{ exit_code: 0 }`, fires `BrowserOpenEvent` callback
- Unknown URL → `{}` (no exit_code), shim falls back to real `xdg-open.real` binary or exits 1

**NOT wired**: The `BrowserOpenEvent` callback is never set. See "Remaining Work" below.

### 2. Shim mounted in agent containers

**File**: `src/container-runner.ts`

The xdg-open shim is now mounted in ALL containers (agent + auth), not just auth containers. Any tool (GitHub CLI, gcloud, Slack CLI, etc.) that calls xdg-open gets intercepted.

### 3. Claude registered programmatically via universal handler

**Files**: `src/auth/providers/claude.ts`, `src/auth/registry.ts`, `src/auth/index.ts`

Claude is no longer registered through a discovery JSON file. Instead, `CLAUDE_OAUTH_PROVIDER` is defined in code with:
- Token exchange: `platform.claude.com/v1/oauth/token` (from packet capture)
- Bearer swap: `api.anthropic.com` and `platform.claude.com`

`registerClaudeUniversalRules()` creates handlers via the universal `createHandler()` factory and registers them with the proxy. The old `handleApiHost` and `handleOAuthTokenExchange` are removed from the proxy dispatch path.

### 4. x-api-key support via provider-specific wrapper

**File**: `src/auth/providers/claude.ts`

`wrapWithApiKeySupport()` wraps the universal bearer-swap handler for `api.anthropic.com`. When `x-api-key` header is present, it resolves the substitute via the token engine and pipes through without refresh logic. When `Authorization: Bearer` is present, it delegates to the universal handler (which handles 401 → refresh → 307).

This keeps the generic handler generic — x-api-key is Claude-specific logic in Claude's code.

### 5. Format-preserving substitutes replace PLACEHOLDER_*

**Files**: `src/container-runner.ts`, `src/auth/providers/claude.ts`

`generateSubstituteCredentials()` in `claude.ts` uses the token engine to generate format-preserving substitutes from real credentials. Container-runner calls it and injects the substitutes as env vars. For OAuth mode, `.credentials.json` is written with substitute access + refresh tokens.

`PLACEHOLDER_*` constants are no longer used in the container startup path. They remain as dead code in `claude.ts` (used only by the old `refresh()` method).

### 6. Bearer-swap 401 handling does its own refresh

**File**: `src/auth/universal-oauth-handler.ts`

`refreshViaTokenEndpoint()` is a generic function that:
1. Finds the token endpoint from the provider's rules
2. Gets the real refresh token from the `PersistentTokenResolver` via `findHandle()`
3. POSTs to the token endpoint
4. Updates the resolver with new access + refresh tokens (which auto-persists)
5. Returns success → bearer-swap handler sends 307 redirect

The old `credentialProviders` registry is removed. No `credProvider.refresh()` call needed.

### 7. PersistentTokenResolver replaces InMemoryTokenResolver

**File**: `src/auth/token-substitute.ts`

Single token storage — the resolver caches access tokens in memory (hot path) and persists all tokens to the encrypted credential store. Refresh tokens are cold (read from disk on demand, not cached in memory).

When persistence is unavailable (e.g. tests without `initCredentialStore()`), refresh tokens fall back to in-memory cache gracefully.

### 8. Old refresh() kept but marked for removal

**File**: `src/auth/providers/claude.ts`

`claudeProvider.refresh()` (the container-spawn approach) is kept with a TODO marker. It's still called by `authGuard` for pre-check. Once the new 401 → refresh flow is proven in production, it should be removed along with the `PLACEHOLDER_*` constants and related dead code.

### 9. Test coverage

25 new tests across 2 new test files:
- `browser-open-handler.test.ts`: 7 tests (known/unknown URLs, callbacks, error cases)
- `providers/claude-universal.test.ts`: 11 tests (provider definition, wrapWithApiKeySupport, substitute config)
- `token-substitute.test.ts`: 7 new tests (PersistentTokenResolver roles, findHandle, role-based storage)
- `universal-oauth-handler.test.ts`: updated 307 refresh test to use `refreshViaTokenEndpoint`

---

## Remaining Work: Research & Design Needed

### A. Browser-open → user messaging integration

**Problem**: `BrowserOpenEvent` fires but nothing receives it. The callback is never set. OAuth URLs from agent containers are detected by the proxy but not relayed to the user.

**What needs to happen**:
1. Wire `setBrowserOpenCallback()` in `index.ts` at startup
2. The callback receives `{ url, scope }` — needs to:
   - Map `scope` (group folder) to the group's chat channel
   - Send the OAuth URL to the user via that channel
   - Set up a listener for the user's reply (callback URL paste)
   - Deliver the callback code to the container

**Design questions**:
- How does the proxy know which container made the request? Currently `scope` comes from container IP → scope mapping. But the proxy doesn't have a reference to the container's localhost callback server port. The shim's request doesn't carry the container's callback port.
- The old flow extracted `redirect_uri` from the OAuth URL to find the callback port. The browser-open handler needs to do the same: parse `redirect_uri` from the URL query params, extract the localhost port, store it so the host can deliver the callback later.
- Who owns the "wait for user reply" lifecycle? The old flow lived inside `runOAuthFlow()` which had the `ExecHandle`. The new flow is triggered by the proxy endpoint, which doesn't have the handle. Needs an event bridge between the proxy and the auth flow orchestrator.
- Does this need to work for agent containers (tools triggering OAuth mid-run) or only auth containers (dedicated auth flows)? If agent containers, the agent process is running and we need to interrupt it with a message to the user, wait for the response, then resume. This is a different lifecycle than auth containers.

**Recommendation**: Start with auth containers only (the existing `runOAuthFlow` + `detectCodeDelivery` path still works there). For agent containers, the browser-open endpoint is the trigger but the callback delivery path needs a new event system — design separately.

### B. Token persistence lifecycle

**Problem**: Two credential stores coexist:
1. The old per-provider encrypted store (`credentials/{scope}/claude_auth.json`) — used by `claudeProvider.provision()`, auth flows, and the old `refresh()`
2. The new `PersistentTokenResolver` store (`credentials/{scope}/claude_access.json`, `claude_refresh.json`) — used by the token engine

**Design questions**:
- On restart, `container-runner.ts` calls `generateSubstituteCredentials()` which calls `claudeProvider.provision()` which reads from the OLD store. The substitutes are then stored in the token engine's NEW store. Both stores have the real tokens.
- When `refreshViaTokenEndpoint()` refreshes tokens, it updates the NEW store via `resolver.update()`. But the OLD store is not updated — `claudeProvider.provision()` will return stale tokens on next container startup.
- Should `provision()` read from the resolver instead of the old store? Or should `refreshViaTokenEndpoint()` also update the old store?
- Can the old store be migrated/eliminated? Auth flows (`auth-login`, `setup-token`, `api_key`) write to the old store. The resolver could be the single store, but auth flows would need to write through it.

**Recommendation**: For now, `refreshViaTokenEndpoint()` should also update the old Claude credential store (via `saveCredential`) so both stores stay in sync. Long-term, migrate auth flows to write through the resolver and eliminate the old per-provider store.

### C. authGuard pre-check without refresh()

**Problem**: `authGuard.preCheck()` calls `provider.refresh(scope)` to ensure tokens are valid before spawning an agent container. If `refresh()` is removed, there's no pre-check.

**Design questions**:
- Is a pre-check needed at all? With the proxy handling 401 → refresh transparently, expired tokens are not fatal — the first API call will trigger a refresh.
- But if the refresh token itself is expired or revoked, the agent will get repeated 401s with no recovery. The pre-check catches this early and triggers interactive reauth.
- Could the pre-check just verify the refresh token exists (not call the token endpoint)?
- Or keep `refresh()` but simplify it to a direct HTTP call (same as `refreshViaTokenEndpoint`) instead of spawning a container?

**Recommendation**: Simplify `refresh()` to a direct HTTP call (reusing `refreshViaTokenEndpoint` or its logic). Keep the pre-check — it's a cheap HTTP call vs. spawning a full agent container that will fail.

### D. ANTHROPIC_BASE_URL custom host registration

**Current state**: `registerClaudeBaseUrl()` exists and is called from `index.ts` when `ANTHROPIC_BASE_URL` is set. It registers the custom host with the universal handler + x-api-key wrapper.

**Not tested**: No test covers this path. The dynamic import chain in `index.ts` is awkward (passes `getTokenEngine()` and `createHandler` as params to avoid circular deps).

### E. Dead code cleanup

Once the new flow is proven:
- Remove `PLACEHOLDER_API_KEY`, `PLACEHOLDER_ACCESS_TOKEN`, `PLACEHOLDER_REFRESH_TOKEN`
- Remove old `refresh()` container-spawn method
- Remove `handleApiHost` and `handleOAuthTokenExchange` (already removed from dispatch)
- Remove `replaceJsonStringValue` import from `claude.ts`
- Remove `CLAUDE_CONFIG_STUB`, `ensureClaudeConfigStub` imports if only used by old refresh
- Remove `detectAuthMode()` from `CredentialProxy` (no longer used for credential injection — token engine handles it)
- Clean up `scripts/test-transparent-proxy.ts` which still uses `PLACEHOLDER_*`

### F. Discovery file authorization_endpoint registration

**Current state**: `registerDiscoveryProviders()` reads `authorization_endpoint` from each discovery JSON and registers patterns with the browser-open handler. Claude's endpoint (`claude.ai/oauth/authorize`) is registered in `registerClaudeUniversalRules()`.

**Gap**: The anthropic.json discovery file still has stale endpoint URLs (`console.anthropic.com` instead of `platform.claude.com`). It's not used for Claude (Claude is registered programmatically), but should be corrected or removed if it causes confusion.
