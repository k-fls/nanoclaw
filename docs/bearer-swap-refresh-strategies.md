# Bearer-Swap Refresh Strategies

When the bearer-swap handler receives a 401/403 from upstream, it buffers the **original error body** (needed for `request_id` extraction), then attempts a token refresh via the token endpoint. What happens next depends on the refresh strategy.

## Common behavior (all strategies)

1. Upstream returns 401/403 → handler buffers the full error body
2. Handler calls `refreshViaTokenEndpoint()` — a side-channel POST to the token endpoint with the real refresh token
3. Refresh response is consumed internally (resolver updated on success, discarded on failure)
4. Whenever the original 401 body is forwarded to the container, the auth error callback is called first (`pendingErrors.record(requestId)`) — before `clientRes.end()`, so the entry exists by the time `onStreamResult` checks it

The container **never** sees the refresh endpoint's response. It only ever sees the original upstream error body or a 307 redirect.

## Strategies

### `redirect` (default)

**Refresh succeeded:** 307 redirect to the same URL. The client re-sends the request with the same substitute token. The proxy swaps it with the now-refreshed real token. Upstream sees the fresh token and returns 200.

**Refresh failed:** Forward the original 401 body to the container. Report to auth error callback.

**Trade-off:** Requires the client to follow 307 redirects and preserve the `Authorization` header (same-host redirect — standard HTTP clients do this). POST body is also preserved by 307 (unlike 302). No request buffering needed on the proxy side.

### `buffer`

**Refresh succeeded:** Replay the original request — the proxy buffered the request body, re-sends it to upstream with the refreshed real token. Returns the new upstream response to the container. The container never sees the 401.

**Refresh failed:** Forward the original 401 body to the container. Report to auth error callback.

**Request too large:** If the request body exceeds the buffer size limit, fall back to `passthrough` (can't replay what wasn't buffered).

**Trade-off:** Transparent to the client — it sees either a successful response or the original error body, never a redirect. Costs memory for buffering the request body. Streaming request bodies (chunked uploads) may not be replayable.

### `passthrough`

**Refresh succeeded or failed:** Always forward the original 401 body to the container. Always report to auth error callback.

If refresh succeeded, the proxy has already updated the token — the client's next request with the same substitute will get the fresh real token. The client handles retry logic itself.

**Trade-off:** Simplest implementation. No redirect, no request buffering. Works with any client. The cost is one extra round-trip (client sees 401, retries, second request succeeds). Useful as a fallback when the client doesn't handle 307, or when `buffer` can't hold the request body.

## Strategy selection

The strategy is set per handler at registration time via `createBearerSwapHandler(..., refreshStrategy)`. Default is `redirect`. The strategy is a property of the provider rule, not of the request — all requests to a given host/path use the same strategy.

| Strategy | On refresh success | On refresh failure | Buffers request? |
|---|---|---|---|
| `redirect` | 307 redirect | Forward 401 + callback | No |
| `buffer` | Replay request | Forward 401 + callback | Yes (up to size limit) |
| `passthrough` | Forward 401 + callback | Forward 401 + callback | No |

## Auth error callback ordering

The callback (`pendingErrors.record(requestId)`) is always called **before** `clientRes.end()`. This is a load-bearing ordering guarantee: `onStreamResult` checks `pendingErrors.has(requestId)` when the container surfaces the error in stdout. The record must exist before the container can see the error body.

```
authErrorCb(upstreamBody, statusCode)   ← sync, records request_id
clientRes.end(upstreamBody)              ← container can now see the error
    ↓ (network + container processing)
onStreamResult → pendingErrors.has(requestId) → true
```
