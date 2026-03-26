# UOAuth Flow Queue

## Problem

Multiple OAuth flows can fire near-simultaneously from different sources (xdg-open shim, proxy interception, Claude console). The agent may be running while OAuth happens. User replies must not get misrouted between the agent and auth flows. Users will serialize auth prompts naturally — the system should match that.

## Flow Queue

Async-safe, ordered queue. Single source of truth for all pending OAuth flows.

**Entry:** `{ flowId, providerId, url, deliveryFn }`

**`flowId`**: `providerId:port` for localhost callbacks, or `providerId:<oauth-url-hash>` when the redirect target is not localhost.

**Semantics:**
- Adding a URL for a provider that already has a pending entry removes the old entry (with reason) and adds the new one at the end
- All mutations (add, remove) include a textual reason parameter, forwarded to the status registry via callbacks
- When the agent container dies, pending entries with dead `deliveryFn` targets (callback ports, stdin pipes) will fail naturally when consumed (ECONNREFUSED, broken pipe). The queue is not flushed on container exit — it lives as a local variable in `handleMessages` and is dropped when `handleMessages` returns
- **Mid-flight delivery:** A `deliveryFn` may be executing when the container dies. Implementations must catch dead-target errors and return `{ ok: false, error: '...' }` rather than throwing

## Status Registry

Separate component from the queue. Receives callbacks from queue mutations and OAuth progress events. Provides scoped status reporting for observability.

**SSE endpoint:** `GET /auth/flow/{flowId}/events`

- Per-flow endpoint
- Replays current state on connect (no missed events if subscriber connects late)
- Streams events with explanation text (the reason string from queue mutations)
- Available to container tools, agent, or anything observing auth lifecycle

**Agent integration:** The agent needs to know about the SSE endpoint so it can track OAuth progress. When the xdg-open shim returns, it includes the `flowId` in the response (e.g. `{"exit_code": 0, "flowId": "github:54321"}`). The agent can then subscribe to the SSE endpoint to watch for `completed`/`failed` events before proceeding. Agent system prompt should include instructions and tools for:
- Subscribing to a specific flow's SSE events by `flowId`
- Listing all current OAuth flow statuses (`GET /auth/flows`) — useful when the agent needs to check if any auth flows are pending or in progress without knowing a specific `flowId`

**Implementation:** `BrowserOpenCallback` returns the `flowId` synchronously. The browser-open handler includes it in the HTTP response: `{"exit_code": 0, "flowId": "claude:54321"}`. The `flowId` is constructed in `pushOAuthFlow` (index.ts) from the OAuth URL's `redirect_uri` and the matched `providerId`.

Event types:
```
event: queued
data: {"providerId":"github","explanation":"xdg-open shim detected GitHub OAuth URL"}

event: active
data: {"providerId":"github","explanation":"presenting to user"}

event: completed
data: {"providerId":"github","explanation":"callback delivered successfully"}

event: failed
data: {"providerId":"github","explanation":"user cancelled"}

event: removed
data: {"providerId":"github","explanation":"new URL superseded old entry"}
```

## Two Independent OAuth Paths

### Stdin path (Claude-only, agent not running)

Claude CLI's `setup-token` mode can show a "Paste code here" prompt on stdout. `detectCodeDelivery` detects this via the paste prompt regex.

- Direct stdin write to the auth container (spawned by `reauth.ts`, not the agent container)
- `detectCodeDelivery` races `wait(file + stdin paste prompt)` — the xdg-open shim writes the OAuth URL to `.oauth-url` in the auth IPC directory, and the reauth orchestrator polls for it alongside the paste prompt. The queue is NOT involved here: reauth runs after the session context is deregistered (or before one exists), so there is no active flow queue to push to. The file-based approach is self-contained within the reauth container's IPC namespace.
- No chat ownership contention — this runs inside the reauth orchestrator's sequential menu flow, where chat ownership is already held and the agent is not running
- No status reporting needed — no agent to inform

### Queue path (shim/proxy, agent may be running)

Triggered by:
- xdg-open shim POSTing to `POST /auth/browser-open` — any provider's OAuth URL detected inside the agent container
- Transparent proxy intercepting a request to a known authorization endpoint

Flow:
1. Source pushes entry to queue with `deliveryFn` and reason
2. Consumer pops front entry
3. Barge-in: pauses agent message stream, takes exclusive chat ownership
4. Presents OAuth URL to user
5. User replies
6. Reply goes to UOAuth, which calls `deliveryFn` and reports to status registry
7. Chat ownership returns to agent

The queue supports **out-of-order consumption** by `providerId` — a consumer can skip ahead and consume a specific provider's entry without waiting for entries ahead of it. This is a general queue capability, currently used by Claude's auth runner: when `onStreamResult` confirms a Claude auth error, it consumes Claude's entry immediately.

A 401 at the proxy level does not immediately kill the agent — the error is passed through to the container, and the agent may retry, continue with other tools, or eventually surface it in streaming output. Only when `onStreamResult` confirms the auth error does `closeStdin()` kill the container. But once that confirmation happens, the agent is dead and Claude auth is a prerequisite for restart — making it wait behind other providers' OAuth prompts would be pointless.

Other providers' flows are presented to the user in FIFO order.

## Chat Ownership

- Active queue flow → queue consumer owns the chat, agent message stream buffered
- No active flow → agent owns the chat

The agent may be:
- Blocked on a tool call that triggered the OAuth → tool unblocks when flow completes, agent continues
- Running → output buffered until flow completes (see backpressure note in Barge-In Mechanism)
- Dead (Claude 401) → agent was killed by `closeStdin()`, reauth runs post-exit via `handleAuthError()`

With the flow queue, barge-in during a live agent run becomes possible — rather than killing the agent on auth error, the system can pause the stream, reauth, and resume. This was not possible in the pre-queue architecture.

**Timeout:** OAuth flows involving MFA, SMS codes, or org admin approval can be lengthy. Flow timeout should be generous (e.g. 10 minutes), not the 120s used by the current reauth menu.

## Barge-In Mechanism (Chat Ownership Lock)

The queue consumer and the streaming callback are independent concerns that share one resource: the chat. An async mutex mediates access.

### Synchronization objects

**`FlowQueue`** — ordered list with notification. Three operations:
- `push(entry)` — append (dedup by provider first: if same `providerId` exists, splice it out, emit `removed`). Wake consumer if blocked.
- `waitForEntry(signal: AbortSignal): Promise<FlowEntry | null>` — blocking pop from front. Blocks when empty, wakes on push or abort. Returns null on abort.
- `removeByProvider(providerId): FlowEntry | undefined` — extract specific entry from anywhere in the queue. Returns it to the caller for processing.

Notification is a simple resolve callback — `push` calls it, `waitForEntry` sets it. Single-threaded Node, no concurrent mutation across await points.

**`AsyncMutex` (`chatLock`)** — acquire/release. Two users: streaming callback and FIFO consumer. Uncontended case (no OAuth): acquire returns immediately, zero overhead.

**`AbortController`** — created per `handleMessages`. Signal passed to consumer loop. Fired when container exits.

### Moving parts

**Producers** (push into queue):
- `handleBrowserOpen` — xdg-open shim POST, resolves scope from container IP, calls `queue.push()`
- Proxy interception — same path, different trigger source

**FIFO consumer** (single loop, lifetime of `handleMessages`):
```
while not aborted:
    entry = await queue.waitForEntry(signal)  // blocks when empty
    if null: break                            // aborted
    await chatLock.acquire()
    present URL → await user reply → call deliveryFn → emit status
    chatLock.release()
```

FIFO is structural — `waitForEntry` pops from front via `shift()`. One loop, one consumer, sequential processing.

**Streaming callback** (per output chunk):
```
await chatLock.acquire()
await channel.sendMessage(chatJid, text)
chatLock.release()
guard.onStreamResult(result)
```

While the lock is held by the queue consumer, the callback blocks. Subsequent `onOutput` calls queue up in the `outputChain` promise chain. When the lock is released, queued messages are delivered in order.

**Claude's auth runner** (post-exit, inside `handleAuthError`):
```
entry = queue.removeByProvider('claude')
if entry: present URL → await reply → call deliveryFn
else: normal reauth menu
```

No `chatLock` needed — consumer is dead, agent is dead, nobody else is using the chat.

### Lifecycle in `handleMessages`

```
1. Create queue, chatLock, abortController
2. Start consumer:  consumerPromise = consumeFlows(queue, chatLock, chat, signal)
3. Run agent        (streaming callback acquires chatLock per sendMessage)
4. Agent exits
5. abortController.abort()          — consumer sees abort
6. await consumerPromise            — consumer finishes: releases chatLock if held, exits
7. handleAuthError()                — may call queue.removeByProvider('claude')
8. return                           — queue, chatLock, abortController go out of scope
```

Steps 5–6 before 7: the consumer is guaranteed dead before Claude's auth runner touches the queue. No race. If the consumer was mid-flow (awaiting user reply for a non-Claude provider), the AbortSignal aborts the reply await, consumer emits `failed` for that flow, releases chatLock, exits.

**Note — no backpressure in current reading pattern:** `container-runner.ts` reads stdout via `container.stdout.on('data', ...)` which never blocks — chunks accumulate in `parseBuffer` (unbounded) regardless of whether `onOutput` is blocked. The container keeps running during an OAuth flow; the agent is not paused. Output arrives in a burst when the lock releases. In practice the agent produces little output during a ~30s OAuth flow, so this is benign — but it is buffering, not backpressure. True pause requires switching to `for await (const chunk of container.stdout)` (async iterator with built-in backpressure) or explicit `pause()`/`resume()` around the `onOutput` await.

### Why this works

Each `onOutput` callback corresponds to a complete JSON object (between `OUTPUT_START_MARKER` and `OUTPUT_END_MARKER`). The `result.result` field is the full text of one agent response — there is no risk of a logically connected message being split across two callback invocations. The lock can be acquired and released per `sendMessage` call with no interleaving concern. Chat messages are never interleaved — the mutex guarantees this regardless of whether the agent is paused or buffered.

### Key cases

| Agent state | Queue event arrives | What happens |
|---|---|---|
| Producing output | Queue consumer acquires lock | Callback blocks on next `sendMessage`, output buffered in `parseBuffer`. Agent keeps running. OAuth flow runs. Lock released, buffered messages delivered. |
| Blocked on tool call (no output) | Queue consumer acquires lock immediately | No contention — nobody is reading the stream. OAuth flow runs. Tool unblocks when `deliveryFn` completes, agent resumes, output flows normally. |
| Dead (Claude 401) | N/A | Container exited, consumer cancelled via `AbortSignal`. Reauth runs post-exit via `handleAuthError()`. |

### Consumer shutdown

`handleMessages` must cancel and await the queue consumer before returning. An `AbortController` signals the consumer to stop; `handleMessages` awaits the consumer's promise to ensure it has released the `chatLock` and exited cleanly. Without this, an orphaned consumer could still be mid-flow (awaiting a user reply for a dead target) when a new agent run starts for the same group — both the orphaned consumer and the new run's streaming callback would write to the same chat with no mutual exclusion.

Cancellation is preferred over draining: don't prompt the user for an OAuth code that can't be delivered to a dead container.

### Why not race in the reader loop

An alternative (racing `Promise.race(nextChunk, queueSignal)` inside `runAgent`) was considered and rejected. It couples `runAgent` / container-runner to auth concerns — infrastructure code shouldn't know about OAuth. The mutex approach keeps auth entirely outside the streaming path. The only touch point is the lock acquisition in the callback, which is generic (it doesn't know why the lock might be held).

## Claude Dual-Mode Detail

Claude CLI has two auth modes that behave differently:

**`setup-token`**: CLI may offer both a paste prompt (stdout) and trigger xdg-open. `detectCodeDelivery` races both signals. Each has its own URL and delivery mechanism:
- Paste prompt → stdout URL, stdin delivery, no queue
- xdg-open shim → shim URL (includes `redirect_uri` with callback port), callback delivery via queue

The race exists because the CLI's behavior depends on whether xdg-open succeeded — the paste prompt is a fallback. Whichever the CLI actually offers first is used. These two paths are independent — they do not interact.

**`auth-login`**: When xdg-open returns 0, the CLI skips the paste prompt entirely. Callback path only. Stdin detection is disabled (`pastePrompt: null`). Always goes through the queue.

## Auth Error Detection

### Dual-confirmation flow

Auth errors require both proxy and agent to agree via request ID correlation. The bearer-swap handler attempts `refreshViaTokenEndpoint` inline on 401/403 — by the time the agent surfaces the error, the proxy has already tried and failed to refresh.

1. Bearer-swap gets 401/403, `refreshViaTokenEndpoint` fails → calls auth error callback → `pendingErrors.record(requestId)`. Upstream error body (with `request_id`) forwarded to container.
2. `onStreamResult` sees error in streaming output → extracts request ID → `pendingErrors.has(requestId)` → confirmed. Sets `streamedAuthError`, calls `closeStdin()` → container dies.
3. Agent exits → `handleAuthError()` runs → checks flow queue for Claude entry (`queue.removeByProvider('claude')`) → if found, processes it directly (no chatLock needed — consumer is dead). If credentials still missing, falls through to `runReauth()`.

Without `pendingErrors` (legacy, no proxy integration): regex match alone is sufficient — no proxy confirmation.

### Provider hook + proxy-confirmed detection

**Container session context:**

A per-`handleMessages` object holding all per-scope state for one agent invocation:

- **Auth error callback** — bearer-swap handler calls on 401 (refresh failed). Wires proxy to `PendingAuthErrors`.
- **OAuth status tracker** — receives callbacks from queue mutations, serves SSE lifecycle events.
- **Scope** — the group's credential scope.

Created in `index.ts` alongside the auth guard. Lives as a local variable in `handleMessages` — outlives the container (reauth runs after container death, before `handleMessages` returns). The proxy's `containerIpToScope` mapping is a separate concern with a separate lifetime: it registers/deregisters with the container as it does today. The auth error callback is the bridge between them — the bearer-swap handler resolves scope from container IP, then looks up the session context's callback. After the container dies, no more proxy requests arrive from that IP, so the callback is never called — no cleanup needed.

This removes `onProxyAuthError` from the provider interface entirely.

**Per-session `PendingAuthErrors`:**

A `PendingAuthErrors` object (thin wrapper around a `Set<string>` of request IDs, with `record(requestId)`, `has(requestId)`, `clear()`) is created per container session — at the same point in `index.ts` where the auth guard is created.

- The auth guard holds a direct reference — `onStreamResult` calls `pendingErrors.has(requestId)` to confirm errors
- The session context's auth error callback connects it to the proxy — the callback extracts provider-specific data (e.g. `request_id` from Anthropic's JSON response) and calls `pendingErrors.record(requestId)`

When the container dies and `handleMessages` returns, the callback is deregistered and the `PendingAuthErrors` goes out of scope. No TTL, no scope-keyed map of trackers, no cleanup logic — lifecycle is container-bounded.

**Claude's flow:**

1. Bearer-swap gets 401/403 from `api.anthropic.com`, `refreshViaTokenEndpoint` fails → resolves session context from container IP → calls auth error callback → callback extracts `request_id` from Anthropic's JSON error response, calls `pendingErrors.record(requestId)`. The upstream error body (containing `request_id`) is forwarded to the container (`universal-oauth-handler.ts` buffers the body, calls `authErrorCb`, then `clientRes.end(upstreamBody)`).
2. `onStreamResult` sees error in streaming output → extracts request ID → calls `pendingErrors.has(requestId)` → confirmed (not a false positive). Unconfirmed errors (proxy didn't record the request ID) are ignored.
3. Auth guard calls `pendingErrors.clear()`, checks flow queue for a queued Claude OAuth URL (`queue.removeByProvider('claude')`), processes it if found, falls through to `runReauth()` if credentials are still missing.

**Benefits:**
- No false positives — both proxy and agent must agree
- Provider-agnostic at the proxy level (any 401/403 calls the session context's auth error callback)
- Agent-side detection can remain loose (just extract request ID, no format-specific regex)
- Works even if the error string format changes — the request ID is the correlation key
- The auth error callback is set per container session, not per provider — different providers can supply different callback logic when the session is created

**Non-Claude providers:** Currently have no OAuth initiation logic, so proxy-detected 401 cannot trigger a reauth flow for them. However, xdg-open shim detection of their OAuth URLs works — those URLs are barged-in to the user via the queue regardless of provider.

## Credential Migration (per-group-auth-flat → ssl-auth-proxy)

The earlier branch (`skill/per-group-auth-flat`) stores Claude OAuth credentials as a single encrypted JSON blob:

**Old format:** `credentials/{scope}/claude_auth.json`
```json
{
  "auth_type": "auth_login",
  "token": "enc:aes-256-gcm:...(encrypted JSON: {\"claudeAiOauth\": {\"accessToken\": \"...\", \"refreshToken\": \"...\", \"expiresAt\": \"...\"}})",
  "expires_at": "...",
  "updated_at": "..."
}
```

The new `PersistentTokenResolver` stores each token separately:

**New format:** `credentials/{scope}/claude_access.json` + `credentials/{scope}/claude_refresh.json`
```json
{ "auth_type": "oauth_token", "token": "enc:aes-256-gcm:...(single token)", "expires_at": null, "updated_at": "..." }
```

On startup (or first `provision()` for a scope), if `claude_access.json` / `claude_refresh.json` do not exist, try to extract them from `claude_auth.json`. If found with `auth_type: 'auth_login'`: decrypt the blob, parse the `claudeAiOauth` JSON, extract `accessToken` and `refreshToken`, store each via `PersistentTokenResolver.store()`. Keep the old `claude_auth.json` intact — it remains the source of truth for `claudeProvider.provision()` and `claudeProvider.refresh()` until those are fully migrated to the token engine. `api_key` and `setup_token` auth types do not need migration — they are single-value tokens that map directly.
