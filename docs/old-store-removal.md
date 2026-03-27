# Old Credential Store Removal

The old per-service store (`credentials/{scope}/{service}.json` via `saveCredential`/`loadCredential`/`hasCredential`) must be fully replaced by the keys file system (`credentials/{scope}/{providerId}.keys.json`) managed through the TokenEngine.

After this work, the only code touching the old store is `migrateClaudeCredentials()`.

## Current old-store usage in `claude.ts`

| Method | Line | Old store call | What it does |
|--------|------|---------------|-------------|
| `hasValidCredentials` | 662 | `hasCredential(scope, SERVICE)` | Fallback after keys file check |
| `importEnv` | 666 | `hasCredential(scope, SERVICE)` | Skip if already imported |
| `importEnv` | 671 | `saveCredential(scope, SERVICE, ...)` | Write .env values as `env_fallback` |
| `storeResult` | 721 | `saveCredential(scope, SERVICE, ...)` | Write reauth result |
| `refresh` | 731 | `loadCredential(scope, SERVICE)` | Read for refresh |
| `refresh` | 843 | `saveCredential(scope, SERVICE, ...)` | Write refreshed creds |

## Changes

### 1. Delete `refresh()` from claude provider

No callers. Remove from `CredentialProvider` interface too.

**Files:** `src/auth/providers/claude.ts`, `src/auth/types.ts`

### 2. Add `expiresTs` to `TokenResolver.store()`

Currently only `PersistentTokenResolver.update()` accepts `expiresTs`. Add it to the `store()` signature so callers don't need to cast to `PersistentTokenResolver`:

```typescript
// TokenResolver interface:
store(realToken: string, providerId: string, credentialScope: CredentialScope, role?: string, expiresTs?: number): void;
```

**Files:** `src/auth/oauth-types.ts` (interface), `src/auth/token-substitute.ts` (PersistentTokenResolver impl)

### 3. New engine method: `hasAnyCredential`

```typescript
hasAnyCredential(
  groupScope: GroupScope,
  providerId: string,
  nonExpired?: boolean,  // default false
): boolean
```

Per group, per provider. Uses `resolveCredentialScope` to determine where to look, then checks the resolver for any stored role (`access`, `api_key`). When `nonExpired` is true, reads `expires_ts` from keys file metadata and rejects tokens past expiry.

Internally uses a private helper for the raw check:

```typescript
private hasKeysInScope(credentialScope: CredentialScope, providerId: string, nonExpired?: boolean): boolean
```

Used by:
- Guard's `preCheck()` with `nonExpired: true` — catches expired credentials proactively
- Engine's `resolveCredentialScope()` — per-provider scope fallback check (via `hasKeysInScope`, no scope resolution)

**Files:** `src/auth/token-substitute.ts`

### 4. Move credential existence check into engine, remove `providerLookup`

`resolveCredentialScope()` and `hasCredentials()` currently call `provider.hasValidCredentials()` via `providerLookup`. Replace:
- `resolveCredentialScope()` uses `hasKeysInScope()` (no scope resolution, raw `CredentialScope`)
- Public `hasCredentials()` replaced by `hasAnyCredential()` (resolves scope, then checks)

This removes:
- `providerLookup` field and `setProviderLookup()` setter from engine
- `hasValidCredentials` from `CredentialProvider` interface
- `setProviderLookup()` wiring in `index.ts`

**Files:** `src/auth/token-substitute.ts`, `src/auth/types.ts`, `src/index.ts`

### 5. Pass engine explicitly to runtime code, reduce `getTokenEngine()` singleton

Current `getTokenEngine()` callers:

| Call site | Keep singleton? | Alternative |
|---|---|---|
| `registry.ts:114` (`registerClaudeUniversalRules`) | **Yes** — startup init, creates the engine | |
| `registry.ts:151` (`registerDiscoveryProviders`) | **Yes** — startup init | |
| `index.ts:603` (wiring at startup) | **Yes** — this is where engine is configured | |
| `index.ts:730` (`registerClaudeBaseUrl`) | **Yes** — startup init | |
| `container-runner.ts:266` | **No** — pass engine to `runContainer` | |
| `guard.ts:68` | Keep `getTokenEngine()` here — guard creation is post-startup, engine exists | |

After: `getTokenEngine()` is only called during startup registration + guard creation. Container runner receives engine explicitly.

**Changes:**
- `runContainer(...)` / `injectSubstituteCredentials(...)` — add engine param
- `runReauth(scope, chat, reason, hint, engine)` — add engine param
- `index.ts`: store engine in module-level variable after startup wiring, pass to container runner and reauth

**Files:** `src/container-runner.ts`, `src/auth/reauth.ts`, `src/index.ts`

### 6. Rewrite `storeResult()` to use TokenEngine

Signature change — engine passed explicitly:

```typescript
storeResult(scope: string, result: FlowResult, tokenEngine: TokenSubstituteEngine): void;
```

Caller chain: `index.ts` → `runReauth(scope, chat, reason, hint, engine)` → `provider.storeResult(scope, result, engine)`

**Credential mode exclusivity:** Setting `api_key` must delete all OAuth credentials (`access`, `refresh`) and their substitutes. Setting OAuth credentials (`access`) must delete `api_key` and its substitutes. This ensures a clean switch between auth modes.

Implementation:

```
storeResult(scope, result, tokenEngine):
  credScope = asCredentialScope(scope)
  switch result.auth_type:
    'api_key':
      tokenEngine.revokeByScope(asGroupScope(scope), CLAUDE_PROVIDER_ID)  // clear all existing
      resolver.store(result.token, CLAUDE_PROVIDER_ID, credScope, 'api_key')

    'setup_token':
      tokenEngine.revokeByScope(asGroupScope(scope), CLAUDE_PROVIDER_ID)
      resolver.store(result.token, CLAUDE_PROVIDER_ID, credScope, 'access')

    'auth_login':
      tokenEngine.revokeByScope(asGroupScope(scope), CLAUDE_PROVIDER_ID)
      parse JSON (result.token contains .credentials.json content)
      expiresTs = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : 0
      resolver.store(parsed.accessToken, CLAUDE_PROVIDER_ID, credScope, 'access', expiresTs)
      resolver.store(parsed.refreshToken, CLAUDE_PROVIDER_ID, credScope, 'refresh')
```

**Files:** `src/auth/types.ts` (interface), `src/auth/providers/claude.ts`, `src/auth/reauth.ts`

### 7. Rewrite `importEnv()` to use TokenEngine

Skip logic moves to the caller (`importEnvToDefault`). The provider's `importEnv` becomes a dumb "read .env, write to resolver".

```typescript
// provision.ts
export function importEnvToDefault(engine: TokenSubstituteEngine): void {
  for (const provider of getAllProviders()) {
    if (engine.hasAnyCredential(asGroupScope('default'), provider.service)) continue;
    provider.importEnv?.('default', engine.getResolver());
  }
}
```

Provider's `importEnv(scope, resolver)` — just reads .env and writes. The .env keys for Claude:
- `ANTHROPIC_API_KEY` → role `api_key`
- `CLAUDE_CODE_OAUTH_TOKEN` → role `access`
- `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` → role `refresh`

Mode exclusivity: API key takes priority over OAuth tokens.

```
importEnv(scope, resolver):
  credScope = asCredentialScope(scope)
  read .env vars
  if ANTHROPIC_API_KEY:
    resolver.store(key, CLAUDE_PROVIDER_ID, credScope, 'api_key')
  else:
    if CLAUDE_CODE_OAUTH_TOKEN → resolver.store(token, ..., 'access')
    if CLAUDE_CODE_OAUTH_REFRESH_TOKEN → resolver.store(token, ..., 'refresh')
```

**Files:** `src/auth/types.ts` (interface), `src/auth/providers/claude.ts`, `src/auth/provision.ts`, `src/index.ts`

### 8. Fix `provision()` direct `readKeysFile` call

Line 704 reads `expires_ts` for writing `.credentials.json`. Add engine method:

```typescript
getKeyExpiry(groupScope: GroupScope, providerId: string, role: TokenRole): number
```

Resolves sourceScope from `ProviderSubstitutes` (same as `resolveRealToken` does), then reads `expires_ts` from the keys file in the resolved credential scope. Returns 0 if not found.

**Note:** Current code reads from `toCredentialScope(groupScope)` which is a bug — when credentials are borrowed from default, the keys file is in `default/`, not the group's own scope. This fix corrects that.

**Files:** `src/auth/token-substitute.ts`, `src/auth/providers/claude.ts`

### 9. Remove old store imports from claude.ts

Remove:
```typescript
import { hasCredential, loadCredential, saveCredential } from '../store.js';
```

Keep `encrypt`/`decrypt` — still needed by migration code.

### 10. Update tests

- `claude.test.ts`: Rewrite `storeResult` tests (pass engine). Remove `refresh()` and `hasValidCredentials` tests. Add mode exclusivity tests (api_key clears OAuth, OAuth clears api_key).
- `guard.test.ts`: Remove `provider.refresh` assertions. Update preCheck to mock `hasAnyCredential` with `nonExpired: true`.
- `reauth.test.ts`: Update mock providers (no `hasValidCredentials`, `storeResult` takes engine). Pass engine to `runReauth`.
- `registry.test.ts`: Update mock provider (no `hasValidCredentials`).
- `provision.test.ts`: Update mock provider. `importEnvToDefault` receives engine.
- `container-runner.test.ts`: Update mock for engine param.

## Future: TokenEngine should use CredentialScope, not GroupScope

The current public API uses `GroupScope` as the primary key, with internal resolution to `CredentialScope`. This forces `'default'` (which is naturally a `CredentialScope`) to be cast to `GroupScope` via `asGroupScope('default')` — a lie to the type system.

A cleaner model: the engine's public API takes `CredentialScope`. Callers use `credentialScopeOf(group)` for group-scoped operations, and `asCredentialScope('default')` for default scope operations. The engine internally handles scope resolution (own → default fallback) via the group resolver when needed. This removes the forced `GroupScope` branding on a scope that isn't a group.

Not blocking for the current work — note for a future pass.

### 11. Rename `provider.service` to `provider.id`

`CredentialProvider.service` is `'claude_auth'` (old store filename). `CLAUDE_PROVIDER_ID` is `'claude'` (keys file name). These don't match — causes bugs in `importEnvToDefault` skip check and `deleteCredential`.

Rename `service` → `id` on the interface. Set Claude's to `'claude'`. `CLAUDE_PROVIDER_ID` constant becomes redundant — replace with `claudeProvider.id`.

Update:
- `CredentialProvider` interface: `service` → `id`
- `claudeProvider`: `service: 'claude_auth'` → `id: 'claude'`
- `registry.ts`: `registry.set(provider.id, ...)`
- `reauth.ts`: logging uses `provider.id`
- All test mocks
- Remove `CLAUDE_PROVIDER_ID` constant, use `claudeProvider.id` everywhere

**Files:** `src/auth/types.ts`, `src/auth/providers/claude.ts`, `src/auth/registry.ts`, `src/auth/reauth.ts`, `src/auth/guard.ts`, tests

### 12. Delete credentials via engine in reauth

`reauth.ts:105` calls `deleteCredential(scope, provider.service)` from the old store. Replace with engine-based deletion:

```typescript
engine.revokeByScope(asGroupScope(scope), provider.id);
// Also delete the keys file on disk
```

`revokeByScope` clears engine state + resolver hot cache + refs file. But `PersistentTokenResolver.revoke()` only clears the hot cache — it does NOT delete the keys file on disk.

Add `deleteKeys(credentialScope, providerId)` to `PersistentTokenResolver` — deletes `credentials/{scope}/{providerId}.keys.json`. Keep it separate from `revoke()` (which is hot-cache cleanup called often). `revokeByScope` calls both `revoke()` and `deleteKeys()` when explicitly requested (user action via reauth menu).

**Files:** `src/auth/reauth.ts`, `src/auth/token-substitute.ts` (PersistentTokenResolver.deleteKeys + revokeByScope calls it)

### 13. Sync refs after credential change

**Critical: `revokeByScope` must NOT clean up refs.** Running containers still hold substitute strings from those refs. Deleting refs would break active containers.

The flow for credential updates:
1. `revokeByScope` clears hot cache + deletes keys file — old real tokens gone from resolver
2. Refs stay in engine memory — old substitutes survive
3. New keys written via `resolver.store()` — new real tokens in place
4. **`pruneStaleRefs`** removes only refs whose role no longer has a matching key

For same-type updates (e.g. new OAuth token replacing old OAuth token): refs survive, substitutes continue to resolve against the new real token. Prune finds nothing to remove.

For mode switches (OAuth → API key): `pruneStaleRefs` removes `access` and `refresh` refs (no keys for those roles anymore). New `api_key` refs generated on next `provision()`.

```typescript
pruneStaleRefs(groupScope: GroupScope, providerId: string): void
```

Iterates all substitutes for (group, provider). For each, checks if the resolver can resolve the real token for that role. If not, removes the substitute from engine map + reverse index. Persists updated refs file.

Called by `storeResult` after revoke + store:
```
revokeByScope(scope, providerId)     // clear hot cache + keys file (refs stay!)
resolver.store(...)                   // write new keys
pruneStaleRefs(scope, providerId)    // remove orphaned refs from roles that no longer exist
```

**Files:** `src/auth/token-substitute.ts`

## Order

1. Rename `provider.service` → `provider.id`, remove `CLAUDE_PROVIDER_ID` constant
2. Delete `refresh()` + remove from interface
3. Add `expiresTs` to `TokenResolver.store()`
4. Add `hasAnyCredential()` + private `hasKeysInScope()` to engine
5. Add `pruneStaleRefs()` to engine
6. Move credential check into engine, remove `providerLookup`, remove `hasValidCredentials` from interface
7. Pass engine explicitly to container-runner, reauth (reduce singleton)
8. Rewrite `storeResult` (engine passed explicitly, mode exclusivity, prune after write)
9. Rewrite `importEnv` (skip check in caller, provider just writes to resolver)
10. Delete credentials via engine in reauth (revokeByScope + deleteKeys, refs stay)
11. Fix `provision()` `readKeysFile` → engine `getKeyExpiry`
12. Remove old store imports from claude.ts
13. Update tests
