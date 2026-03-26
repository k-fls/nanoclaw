# REJECTED - DO NOT USE #

# Reauth Orchestrator — Queue Integration Refactor

## Problem

The reauth orchestrator and `detectCodeDelivery` use a file-based mechanism (`.oauth-url`) for the xdg-open shim callback path. The flow queue now handles this during agent runs, but the reauth path (which runs without an agent) still uses the old file-polling approach. This creates two parallel delivery mechanisms for the same signal.

### Current state

**Agent running (queue path — implemented):**
```
xdg-open shim → POST /auth/browser-open → browser-open handler
  → looks up session context by scope → pushes to session's FlowQueue
  → FIFO consumer presents URL to user → user replies → deliveryFn
```

**Reauth (file path — legacy):**
```
xdg-open shim → POST /auth/browser-open → callback fires (but no session context)
  → logs "no session context for scope", silently drops

Meanwhile inside the auth container:
xdg-open shim → writes .oauth-url file to auth-ipc mount
  → detectCodeDelivery polls the file → finds callback port → builds callbackHandler
  → runOAuthFlow presents URL to user → user replies → deliver()
```

The file-based path works because the auth container has an `auth-ipc` directory mounted where the shim writes `.oauth-url`. This is independent of the flow queue.

### Why it matters

1. **Two delivery mechanisms** — the shim POST to `/auth/browser-open` is wasted during reauth (no session context). The file write in the shim is the actual delivery channel. If the shim changes, both paths need updating.

2. **No session context during reauth** — `handleBrowserOpen` requires a session context to push to the flow queue. During reauth, the session context is either not yet created (preCheck) or deregistered (post-agent). The browser-open callback silently drops the event.

3. **`detectCodeDelivery` is Claude-specific** — it lives in `providers/claude.ts`, understands `redirect_uri` parsing, `localhost` callback ports, and `.oauth-url` file format. If other providers need the same xdg-open → user → code delivery pattern, this logic can't be reused.

## Proposed Change

Replace `detectCodeDelivery`'s file-polling leg with queue-based delivery. The paste-prompt leg (stdin) stays unchanged — it's orthogonal and doesn't involve the shim.

### Key insight

During reauth, the reauth orchestrator owns the chat and spawns the auth container. It can create a temporary flow queue (not tied to a session context) and register it with the browser-open handler for the duration of the auth flow.

### Design

**New: per-reauth flow queue**

```
runOAuthFlow():
  1. Create temporary FlowQueue
  2. Register it with browser-open handler: setBrowserOpenQueue(scope, queue)
  3. Spawn auth container (same as today)
  4. Wait for OAuth URL in stdout (same as today)
  5. Race:
     (a) paste prompt in stdout → stdin handler (unchanged)
     (b) queue.waitForEntry(signal) → queue handler (replaces file polling)
  6. Whichever wins → present URL to user, deliver code
  7. Deregister queue: clearBrowserOpenQueue(scope)
```

**browser-open handler changes:**

Currently the handler has a single global `_onBrowserOpen` callback. Extend it to also check per-scope queues:

```ts
// In handleBrowserOpen:
const providerId = matchAuthorizationUrl(url);
if (!providerId) { /* pass-through */ }

// Try session context first (agent running)
const ctx = proxy.getSessionContext(scope);
if (ctx) {
  pushOAuthFlow(ctx, url, containerIP, providerId, reason);
  return;
}

// Try per-scope reauth queue (reauth running)
const reauthQueue = _reauthQueues.get(scope);
if (reauthQueue) {
  reauthQueue.push({ flowId, providerId, url, deliveryFn: null }, reason);
  return;
}

// Neither — log warning (no one is listening)
```

The `_reauthQueues` map is registered/deregistered by `runOAuthFlow`.

**detectCodeDelivery refactor:**

Replace the file-polling interval with `queue.waitForEntry`:

```ts
// Current (file polling):
const check = setInterval(() => {
  if (pastePrompt && pastePrompt.test(outputRef.value)) {
    done(stdinHandler(...));
    return;
  }
  try {
    const url = fs.readFileSync(oauthUrlPath, 'utf-8').trim();
    // parse redirect_uri, check port, build callbackHandler
  } catch {}
}, 500);

// Proposed (queue-based):
const stdinPromise = pastePrompt
  ? waitForPattern(outputRef, pastePrompt, timeoutMs)
      .then(m => m ? stdinHandler(stdoutOauthUrl, handle) : null)
  : new Promise<null>(() => {}); // never resolves

const queuePromise = queue.waitForEntry(signal)
  .then(entry => entry ? queueHandler(entry) : null);

return Promise.race([stdinPromise, queuePromise, handle.wait().then(() => null)]);
```

The `queueHandler` builds a `CodeDeliveryHandler` from the flow entry:
- `oauthUrl` from `entry.url`
- `instructions` same as current `callbackHandler`
- `deliver()` calls `entry.deliveryFn(reply)` if present, or parses the callback URL and delivers directly (same as current `callbackHandler.deliver`)

### What changes

| Component | Before | After |
|-----------|--------|-------|
| `detectCodeDelivery` | Polls `.oauth-url` file every 500ms | `queue.waitForEntry(signal)` |
| `runOAuthFlow` | Creates auth-ipc dir, cleans stale `.oauth-url` | Creates temp FlowQueue, registers with browser-open handler |
| `browser-open handler` | Single global callback (drops during reauth) | Global callback + per-scope reauth queues |
| xdg-open shim | POST to `/auth/browser-open` + writes `.oauth-url` | POST to `/auth/browser-open` only (file write removed) |
| `.oauth-url` file | Used by `detectCodeDelivery` | Removed |
| auth-ipc mount | Required for `.oauth-url` | Not needed for this purpose (may still be used by other IPC) |

### What doesn't change

- **Paste prompt detection** (stdin path) — unchanged, still polls stdout
- **Reauth menu** (`reauth.ts`) — unchanged, still shows numbered options
- **Flow queue semantics** — same `FlowQueue` class, same `push`/`waitForEntry`/`removeByProvider`
- **Agent-running path** — session context + FIFO consumer, unchanged
- **`handleAuthError` queue integration** (gap #1 fix) — still calls `removeByProvider('claude')`

### Migration

1. Add `_reauthQueues: Map<string, FlowQueue>` + `registerReauthQueue`/`clearReauthQueue` to `browser-open-handler.ts`
2. Update `handleBrowserOpen` to check reauth queues after session context
3. Refactor `detectCodeDelivery` to accept a `FlowQueue` instead of `authIpcDir`
4. Update `runOAuthFlow` to create and register a temp queue
5. Remove `.oauth-url` file handling from shim and `runOAuthFlow`
6. Update tests: `detectCodeDelivery` tests switch from file fixtures to queue mocks

Steps 1-4 can be done incrementally with the file path as fallback until step 5 removes it.

### Risks

- **Auth container xdg-open shim** must still POST to `/auth/browser-open` for the queue path to work. Currently it does. The shim's `.oauth-url` file write is an additional signal that becomes redundant.
- **Timing**: the browser-open POST arrives when the xdg-open shim runs inside the auth container. The shim runs because `claude setup-token` / `claude auth login` triggers `xdg-open`. The POST must arrive before `detectCodeDelivery` times out. Current timeout is `DELIVERY_DETECT_MS` (configurable). The queue-based path is faster than file polling (instant notification vs 500ms interval).
- **auth-ipc mount removal**: if other files are written to auth-ipc (not just `.oauth-url`), the mount must stay. Check for other uses before removing.
