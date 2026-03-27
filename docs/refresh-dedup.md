# Refresh Deduplication

## Problem

When multiple containers share a credential scope (e.g. `default`), concurrent 401s trigger concurrent refresh attempts. With single-use refresh tokens, the second attempt fails. Even with reusable tokens, concurrent writes to the resolver race.

## Solution: Single-flight on the engine

The engine coalesces concurrent operations on the same `(credentialScope, providerId, operationType)` key. The first caller runs the operation; concurrent callers await the same promise. The promise resolves only after tokens are written to the resolver (hot cache + keys file), so coalesced callers see the updated tokens immediately.

```typescript
// On TokenSubstituteEngine:
private inflight = new Map<string, Promise<boolean>>();

/**
 * Run an async operation at most once per (credentialScope, providerId, op) key.
 * Concurrent callers for the same key share the result of the first caller.
 * The operation must write tokens to the resolver before resolving.
 */
dedup<T>(
  credentialScope: CredentialScope,
  providerId: string,
  op: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${credentialScope}\0${providerId}\0${op}`;
  const existing = this.inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => this.inflight.delete(key));
  this.inflight.set(key, p as Promise<unknown>);
  return p;
}
```

## Keying

- **credentialScope** (not groupScope) — two groups borrowing from `default` must coalesce into one refresh
- **providerId** — different providers refresh independently
- **operationType** — `'refresh'` vs `'store'` (reauth). A refresh and a reauth for the same scope+provider are different operations and must not block each other

## Usage

### Bearer-swap refresh (universal-oauth-handler.ts)

```typescript
// In refreshViaTokenEndpoint:
const effScope = tokenEngine.getEffectiveScope(groupScope, provider.id);
return tokenEngine.dedup(effScope, provider.id, 'refresh', async () => {
  const realRefreshToken = tokenEngine.resolveRealToken(groupScope, provider.id, 'refresh');
  if (!realRefreshToken) return false;
  // ... token endpoint call ...
  tokenEngine.refreshCredential(groupScope, provider.id, 'access', newAccessToken, expiresTs);
  // tokens written before promise resolves
  return true;
});
```

### storeResult (reauth)

```typescript
// storeResult uses 'store' operation type — does not conflict with refresh
tokenEngine.dedup(credScope, providerId, 'store', async () => {
  // revoke + write + prune
  return true;
});
```

## Failure behavior

If the refresh fails, all coalesced callers get `false`. Each container's bearer-swap handler then fires the auth error callback, which records the 401. The container surfaces the error, and the guard triggers reauth. This is correct — one failed refresh = one reauth, not N.

## Not needed

- Mutex/lock — heavier than necessary for Node.js single-threaded async
- Retry in the dedup layer — retry logic belongs in the caller (bearer-swap strategy: redirect, buffer, passthrough)
- Expiry check before refresh — the bearer-swap handler only calls refresh after receiving a 401, so the token is already known to be invalid
