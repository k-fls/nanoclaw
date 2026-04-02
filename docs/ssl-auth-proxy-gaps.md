# ssl-auth-proxy Implementation Gaps

Audit of `docs/oauth-flow-queue.md`, `docs/claude-universal-oauth-integration.md`, and `docs/bearer-swap-refresh-strategies.md` against the current implementation on `skill/ssl-auth-proxy`.

---

## 1. `buffer` and `passthrough` refresh strategies not implemented

**Docs:** `bearer-swap-refresh-strategies.md` defines three strategies. `claude-universal-oauth-integration.md` section 5 references passthrough-with-hold as fallback. Implementation order step 7: "Test 307 compatibility with Claude SDK, implement fallback if needed."

**Code:** `RefreshStrategy = 'redirect' | 'buffer' | 'passthrough'` exists in `oauth-types.ts:90`. `createBearerSwapHandler` accepts the `refreshStrategy` parameter and logs it, but all code paths do `redirect` — the parameter is unused.

**What's missing:**

### `buffer` strategy
On refresh success: replay the original request with the refreshed token and return the real response. The container never sees the 401.

Requires:
- Buffer request body before piping upstream (currently `clientReq.pipe(upstream)` at `universal-oauth-handler.ts:312` streams it through, making replay impossible)
- Size limit with fallback to `passthrough` when request body exceeds it
- Re-send buffered body to upstream with fresh real token
- Pipe the new upstream response to the container

### `passthrough` strategy
On refresh success or failure: always forward the original 401 body to the container. Always call the auth error callback.

Requires:
- On refresh success path (currently lines 290-298): instead of 307 redirect, forward the buffered 401 body and call `authErrorCb`. The proxy has already refreshed the token, so the client's next request will succeed.
- Auth error callback ordering guarantee must hold (callback before `clientRes.end()`) even on the success path.

### `passthrough` auth error callback on success — why it works
The callback records `requestId` in `pendingErrors`. If the client retries successfully (common case), the error never appears in streaming output, `onStreamResult` is never triggered, and the container continues. If the client doesn't retry and surfaces the error, the guard catches it, kills the container, and `handleAuthError` finds valid (already-refreshed) credentials — reauth succeeds immediately with no user interaction.

---

## 2. Substitute mappings are not persisted — NanoClaw restart breaks running containers

**Code:** `TokenSubstituteEngine.scopes` (`token-substitute.ts:177`) is a plain in-memory `Map<string, Map<string, SubstituteMapping>>`. On NanoClaw restart, it's empty.

Containers hold substitute tokens in env vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) and on disk (`.credentials.json` in the session directory). These survive NanoClaw restarts. When the container's next API request arrives at the proxy, `resolveSubstitute()` returns null — the substitute is unknown. The unresolved substitute hits upstream as-is and gets rejected.

**What needs persisting:** The substitute → handle mappings (substitute string, handle, providerId, scopeAttrs, containerScope, role). No real tokens — just the identity mapping. On startup, `TokenSubstituteEngine` should load persisted mappings so existing containers' substitutes still resolve.

**Storage:** One unencrypted JSON file per provider per scope: `credentials/{scope}/<provider>.refs.json`. The file only contains the mapping from substitute strings to handles — it points to the real token storage but contains no secrets itself. Substitute tokens are format-preserving random strings with no cryptographic relationship to the real tokens.

Naming convention for `credentials/{scope}/`:
- `<provider>.keys.json` — encrypted real tokens (all roles for one provider in one file)
- `<provider>.refs.json` — unencrypted substitute → handle mappings (includes role per entry)

**Write path:** `generateSubstitute` already calls `resolver.store()` which persists real tokens. It must also persist the substitute → handle mapping in the refs file at the same point. Consistency between refs and keys only matters on write — both must be written before the substitute is returned to the caller.

**Startup (NanoClaw restart):**
1. Load `<provider>.refs.json` → rebuild engine's `scopes` map (substitute → mapping with handle)
2. For each mapping, register a **cold stub** in the resolver's `tokens` map: `this.tokens.set(handle, { providerId, containerScope, role, realToken: null })`. This reuses the existing cold path in `resolve()` (`token-substitute.ts:91-93`) — when `realToken` is null, it calls `loadFromStore()` which reads from `<provider>.keys.json` on demand.
3. No need to preload real tokens into the hot cache. No need to call `store()` or `generateSubstituteCredentials` again.

The cold stub approach requires no changes to `resolve()` or the handle format — it's the same mechanism already used for refresh tokens with successful persistence (`store()` at line 77: `realToken: isCold ? null : realToken`).

---

## 3. Dual credential stores — wrong file names, real tokens loaded unnecessarily

**Code:** Two credential stores coexist:

- **Old store**: `credentials/{scope}/claude_auth.json` — single encrypted JSON blob with all tokens. Written by auth flows (`auth-login`, `setup-token`, `api_key`). Read by `claudeProvider.provision()`.
- **New store**: `credentials/{scope}/claude_access.json`, `claude_refresh.json` — written by `PersistentTokenResolver.persist()` via `storeKey(providerId, role)` which produces `claude_access`, `claude_refresh` as credential keys.

Problems:
1. New store uses wrong file names — should be `<provider>.keys.json` per gap #2 naming convention.
2. `generateSubstituteCredentials` loads real tokens from old store and creates new random substitutes on every container startup. Real tokens should never be loaded when substitutes already exist.
3. `provision()` exposes `CLAUDE_REFRESH_TOKEN` in env — refresh tokens are only needed in `.credentials.json`, never in env.
4. `.credentials.json` sets `expiresAt: 0`, forcing refresh on every startup. Should use real expiry from keys file.

**Fix — two layers:**

**Engine (generic):** `TokenSubstituteEngine.generateSubstitute()` changes behavior to return existing substitute if one already exists for (scope, providerId, role), otherwise generate a new one. When multiple substitutes exist for the same role (from token refreshes), sort as strings and return first — stable and deterministic. This is a behavioral change to the existing method, not a new API.

**Provider (Claude-specific):** `claudeProvider.provision(scope, tokenEngine)` takes the engine as arg. Calls `tokenEngine.generateSubstitute(realToken, providerId, ..., role)` for each role. The engine returns existing substitutes when available (ignoring the realToken arg). The provider assembles the Claude-specific output:
- Env vars: `ANTHROPIC_API_KEY` (api_key role) or `CLAUDE_CODE_OAUTH_TOKEN` (access role). No refresh token in env.
- `.credentials.json` with substitute access + refresh tokens and real `expiresAt`

On first call (no refs file — migration from old store): the engine has no existing substitutes, so it generates from the provided real tokens and persists refs + keys. After that, existing substitutes are returned and the real token arg is unused.

`generateSubstituteCredentials` in `claude.ts` becomes dead code — `provision()` handles everything. `container-runner.ts` calls `provision()` directly.

---

## 4. API key 401s are invisible to the auth guard

**Docs:** `claude-universal-oauth-integration.md` section 3: "API key mode: Do NOT attempt refresh. Pass the 401 through immediately. API keys don't refresh — auth errors escalate to the user via the existing authGuard.handleAuthError path."

**Code:** `wrapWithApiKeySupport` (`claude.ts:542-561`) uses `proxyPipe` for API key requests — no body buffering, no 401 detection, no auth error callback. The 401 body is piped directly to the container.

When the agent surfaces the error in streaming output, `isConfirmedAuthError` in `guard.ts:49-67` requires proxy confirmation (`pendingErrors.has(requestId)`). Since API key 401s are never recorded in `pendingErrors`, confirmation always fails. The guard silently ignores the error:

```
Auth error in stream not confirmed by proxy — ignoring (not a confirmed auth error)
```

The container exits with an undetected auth error. `handleAuthError` returns `'not-auth'`. No reauth triggered.

**Fix:**: `wrapWithApiKeySupport` detects 401 responses and calls the auth error callback (needs body buffering, losing the simplicity of `proxyPipe`)

---

## 5. Agent system prompt doesn't include SSE endpoint instructions

**Doc:** `oauth-flow-queue.md` lines 32-34: "Agent system prompt should include instructions and tools for: subscribing to a specific flow's SSE events by `flowId`, listing all current OAuth flow statuses (`GET /auth/flows`)."

**Code:** The SSE endpoint (`GET /auth/flow/{flowId}/events`) and list endpoint (`GET /auth/flows`) are wired in `credential-proxy.ts:621-643`. But no container skill, system prompt, or agent configuration mentions these endpoints. The `handleBrowserOpen` response includes `flowId` in the HTTP response to the shim (`browser-open-handler.ts:148`), and the shim returns it as the exit code result, but the agent has no instructions for using it.

**Impact:** The agent cannot proactively monitor OAuth flow progress. If xdg-open returns 0 (shim intercepted the URL), the agent has no way to know when the flow completes — it would need to blindly retry the failed operation.

---

## 6. Dead code to remove

### `claudeProvider.refresh()` — `claude.ts:725-830`
Spawns an interactive Claude container, sends `"reply: hi"`, waits for output — 30s overhead. Replaced by `refreshViaTokenEndpoint` at the proxy level. Not called from any production code (only referenced in test mocks at `guard.test.ts`). Dont remove.

### `PLACEHOLDER_*` constants — `claude.ts:48-50`
`PLACEHOLDER_API_KEY`, `PLACEHOLDER_ACCESS_TOKEN`, `PLACEHOLDER_REFRESH_TOKEN`. Only referenced by the dead `refresh()` method. Container startup now uses `generateSubstituteCredentials` with the token engine.

### `removeByProvider` — `flow-queue.ts:115-124`
Remove entirely, no replacement needed. The only call site (`guard.ts:111`) processes a queued Claude OAuth entry after the container is dead — but the entry's `deliveryFn` targets the dead container's bridge IP:callback_port. `processFlow` would present the URL, collect the user's reply, fail delivery with ECONNREFUSED, and fall through to `runReauth()` anyway. Removing it lets `handleAuthError` go straight to `runReauth()` without the false start.

---

## 7. Minor doc/implementation divergences (non-functional)

### Endpoint path naming
`claude-universal-oauth-integration.md` section 1 says `POST /_auth/browser-open` (underscore prefix). Implementation and shim both use `/auth/browser-open`. No impact.

### Unknown URL response from browser-open handler
Doc says `{ exit_code: 1 }` for unknown URLs. Implementation returns `{}` (no `exit_code`). Shim falls through to try real `xdg-open.real`, then exits 1. The implementation is better — it allows legitimate non-OAuth URLs to be opened by a real browser if available. The doc should be updated, not the code. But it requires changes for `xdg-open` to be copied as `xdg-open.real` before being replaced by mounting.

### flowId format is incorrect
Current format: `providerId:port` (localhost) or `providerId:<base64(redirect_uri)[:12]>` (non-localhost). Two problems:

1. Localhost flows omit the hash — two flows for the same provider with different callback ports but the same OAuth token are distinguishable, but two flows on the same port with different tokens are not.
2. Non-localhost flows hash the redirect_uri, not the OAuth token — different auth attempts for the same redirect target collapse into the same flowId.

Should be: `<provider_id>:<callback_port | 0>:<hash(oauth.state)[:8]>`. The `state` parameter is the OAuth protocol's own flow identifier — unique per flow, present in the authorization URL at interception time, and preserved through the redirect callback. This encodes the callback port (for delivery routing) and a per-flow identity (for dedup). Port 0 for non-localhost flows.

### `oauth-flow-queue.md` line 82 wording
"when `onStreamResult` confirms a Claude auth error, it consumes Claude's entry immediately" — suggests `removeByProvider` is called from `onStreamResult`. Actually, `onStreamResult` only sets `streamedAuthError` and calls `closeStdin()`. Consumption happens post-exit in `handleAuthError()` (correctly described in the doc's own lifecycle section at line 165, step 7).
