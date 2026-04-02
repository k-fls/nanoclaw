# Universal OAuth Provider System for MITM Proxy

## Context

The current proxy has hardcoded Claude-specific handlers (`handleApiHost`, `handleOAuthTokenExchange` in `src/auth/providers/claude.ts`) and a generic but unused `OAuthProviderConfig` system in `src/oauth-interceptor.ts`. We have 64 OIDC discovery files in `src/auth/oauth-discovery/` covering 60+ providers. The goal is a discovery-file-driven system where adding a provider = dropping a JSON file, no code changes.

Key design decisions from discussion:
- 3-level matching (anchor → host regex → path regex), each atomic
- Named regex groups are ONLY scoping attrs, never informational
- Token substitutes are format-preserving with randomized middle sections
- Attrs extracted from API URLs become restrictions on token applicability
- Substitutes are unique per (container_scope, provider, scope_attrs)

## Types

New file: `src/auth/oauth-types.ts`

```ts
interface InterceptRule {
  anchor: string;           // one domain suffix or exact host
  hostPattern?: RegExp;     // named groups = scope attrs. absent = always proceed
  pathPattern: RegExp;      // per-request match
  mode: 'token-exchange' | 'authorize-stub' | 'bearer-swap';
}

interface OAuthProvider {
  id: string;               // filename sans .json
  rules: InterceptRule[];
  scopeKeys: string[];      // which named groups scope credentials
  substituteConfig: SubstituteConfig;
}

interface SubstituteConfig {
  prefixLen: number;        // chars to preserve from start
  suffixLen: number;        // chars to preserve from end
  delimiters: string;       // delimiter chars to preserve in-place (e.g. "-._")
}

const MIN_RANDOM_CHARS = 16;  // global safety floor

interface TokenEntry {
  realToken: string;
  providerId: string;
  scopeAttrs: Record<string, string>;
  containerScope: string;
  expiresAt?: number;
}
```

## 1. Discovery File Loader

New file: `src/auth/discovery-loader.ts`

Reads `src/auth/oauth-discovery/*.json` at startup. For each file:

**Extract hosts from endpoint URLs:**
- Parse `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `userinfo_endpoint`, `api_base_url`
- Extract hostname from each URL
- If URL contains `{placeholder}`: hostname is templated

**Build anchor (Level 1):**
- Fixed host → anchor = exact hostname (`api.anthropic.com`)
- Templated host → anchor = fixed suffix (`auth0.com` from `{tenant}.auth0.com`)

**Build hostPattern (Level 2):**
- Only for templated hosts
- `{tenant}.auth0.com` → `/^(?<tenant>[^.]+)\.auth0\.com$/`
- `{domain}.auth.{region}.amazoncognito.com` → `/^(?<domain>[^.]+)\.auth\.(?<region>[^.]+)\.amazoncognito\.com$/`
- Fixed host → no hostPattern (Level 2 always proceeds)

**Build pathPattern + mode (Level 3):**
- `token_endpoint` path → mode `token-exchange`
- `authorization_endpoint` path → mode `authorize-stub`
- `api_base_url` path → mode `bearer-swap` (prefix match)
- `revocation_endpoint`, `userinfo_endpoint` → mode `bearer-swap`
- If no `api_base_url`: generate catch-all `bearer-swap` rule (`/^\//)` for each host that has endpoints but isn't token or authorize

**Each endpoint URL produces exactly one InterceptRule.** One host + one path + one mode.

**Split-host providers (Google, Intuit):** Multiple rules with different anchors, all belonging to the same `OAuthProvider`. Google example produces ~4 rules across `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `www.googleapis.com`. For wildcard API hosts (`*.googleapis.com`), use `_api_hosts` field in the discovery JSON listing additional bearer-swap hosts.

**scopeKeys:** Union of all named group names across all hostPattern regexes for the provider.

**SubstituteConfig:** From `_token_format` field in discovery JSON, or defaults: `{ prefixLen: 10, suffixLen: 4, delimiters: "-._" }`.

## 2. Token Substitute Engine

New file: `src/auth/token-substitute.ts`

**Data structure:**
- `substituteToReal: Map<string, TokenEntry>` — lookup by substitute string. One-directional only. Multiple substitutes can point to the same real token (e.g., after token refresh issues a new substitute while the old one still exists). Old entries are cleaned up by `revokeByScope`.

**`generateSubstitute(realToken, providerId, scopeAttrs, containerScope, config)`:**
1. Split: prefix (config.prefixLen), suffix (config.suffixLen), middle
2. If `middle.length - delimiters_in_middle < MIN_RANDOM_CHARS` → refuse (return null, log warning)
3. Randomize middle char-by-char preserving: delimiters in-place, character class (`[a-z]→[a-z]`, `[A-Z]→[A-Z]`, `[0-9]→[0-9]`)
4. Collision check against `substituteToReal` (retry up to 3x)
5. Store in map, return substitute

**`resolveSubstitute(substitute)`:** → `TokenEntry | null`

**`resolveWithRestriction(substitute, requiredAttrs)`:**
- Look up entry
- If entry has scopeAttrs and requiredAttrs is non-empty: every key in requiredAttrs must match entry's scopeAttrs. Mismatch → return null (prevents cross-tenant token injection)
- If requiredAttrs is empty (API host has no attrs): allow (no restriction)
- If entry's scopeAttrs has keys but requiredAttrs doesn't: also allow (fallback — handles the Microsoft case where token-exchange extracts tenant but API host doesn't)

**`revokeByScope(containerScope, providerId?)`:** Clear entries. Called on container exit or reauth.

**In-memory only.** Substitutes are ephemeral — regenerated on each token exchange.

## 3. Universal OAuth Handler

New file: `src/auth/universal-oauth-handler.ts`

**Factory function:** `createHandler(provider: OAuthProvider, rule: InterceptRule, tokenEngine: TokenSubstituteEngine): HostHandler`

Returns a `HostHandler` that:

1. Extracts `scopeAttrs` from hostname via `rule.hostPattern` (if present)
2. Dispatches by `rule.mode`:

**bearer-swap:**
- Extract Bearer token from Authorization header
- Call `tokenEngine.resolveWithRestriction(substitute, scopeAttrs)`
- If resolved → swap header. If null → passthrough (let container's placeholder hit upstream, get 401)
- Call `proxyPipe()` with scope for response hook

**token-exchange:**
- Reuse `handleTokenExchange` from `oauth-interceptor.ts` with callbacks wired to tokenEngine:
  - `resolveRefreshToken(sub)` → `tokenEngine.resolveSubstitute(sub)?.realToken`
  - `onTokens(real)` → `tokenEngine.generateSubstitute(real.access_token, ...)` + same for refresh_token → return substitute TokenSet
  - `resolveAccessToken` → not used here (that's bearer-swap path)

**authorize-stub:**
- Reuse `handleAuthorizeStub` from `oauth-interceptor.ts`
- Default callback: forward (passthrough). Provider-specific overrides possible.

## 4. Registration / Wiring

**Modified: `src/auth/registry.ts`**

New function `registerDiscoveryProviders()`:
1. Call discovery loader → get `Map<string, OAuthProvider>`
2. For each provider, for each rule:
   - Build the handler via `createHandler(provider, rule, tokenEngine)`
   - Call `proxy.registerProviderHost(hostPatternRegex, pathPattern, handler)`
   - Call `proxy.registerAnchor(rule.anchor)` (new method)

**Modified: `src/credential-proxy.ts`**

Add anchor-based Level 1 optimization:
```ts
private anchorSet = new Set<string>();

registerAnchor(anchor: string): void {
  this.anchorSet.add(anchor);
}

shouldIntercept(targetHost: string): boolean {
  // Exact match
  if (this.anchorSet.has(targetHost)) return true;
  // Suffix match (for *.auth0.com etc.)
  for (const anchor of this.anchorSet) {
    if (targetHost.endsWith('.' + anchor)) return true;
  }
  return false;
}
```

Remove the old `hostRules.some(r => r.hostPattern.test(...))` from `shouldIntercept`. The `matchHostRule` method continues to use hostRules for Level 2+3 dispatch.

**Modified: `src/index.ts`**

```
const proxy = new CredentialProxy();
setProxyInstance(proxy);
registerDiscoveryProviders();     // discovery-file providers (generic)
registerBuiltinProviders();       // Claude provider (overrides/extends)
proxy.setCredentialResolver(...);
```

**Modified: `src/auth/index.ts`**

Export `registerDiscoveryProviders` from registry.

## 5. Error Detection and Inline Refresh

**Modified: `src/auth/universal-oauth-handler.ts` (bearer-swap path)**

After `proxyPipe` completes (via response hook):
- If `statusCode` is 401 or 403:
  - Look up the `CredentialProvider` for this `providerId` (if one is registered — Claude has one, generic providers may not)
  - Call `provider.refresh(containerScope, force=true)` if available
  - If refresh succeeds, update the real token in the tokenEngine entry
  - The container's SDK will retry the request, getting the fresh token
- If no `CredentialProvider.refresh` exists for this provider, log and let the container handle the error

The response hook (`ProxyResponseHook`) already has `scope`, `statusCode`, and `targetHost`. Wire it to call back into the universal handler's error logic.

## 6. Claude Migration (Phase 2, separate PR)

- Remove `handleApiHost`, `handleOAuthTokenExchange`, `injectClaudeCredentials`, `forwardToClaude` from `claude.ts`
- Remove `hostRules` from `claudeProvider`
- The discovery file `anthropic.json` provides the rules; `claude.ts`'s `SubstituteConfig` is set via `_token_format`:
  ```json
  "_token_format": { "prefixLen": 14, "suffixLen": 4, "delimiters": "-" }
  ```
- Keep: `provision()`, `storeResult()`, `refresh()`, `authOptions()` — these are credential lifecycle, not proxy concerns
- Replace `PLACEHOLDER_API_KEY`/`PLACEHOLDER_ACCESS_TOKEN`/`PLACEHOLDER_REFRESH_TOKEN` with tokenEngine-generated substitutes
- `injectClaudeCredentials` logic (x-api-key vs Authorization) becomes a custom bearer-swap variant or a provider-specific callback

## 7. Extensibility Points

- **New provider**: drop JSON in `src/auth/oauth-discovery/`, restart
- **Custom/self-hosted**: user drops JSON with their specific URLs
- **Provider-specific logic**: implement `CredentialProvider` with `hostRules` that register after discovery rules (first match wins, built-in overrides generic)
- **Token format**: `_token_format` field in discovery JSON
- **Additional API hosts**: `_api_hosts` array in discovery JSON for hosts not in standard OIDC fields
- **Custom domains**: user provides explicit JSON with the custom domain, no regex needed

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/auth/oauth-types.ts` | **new** | InterceptRule, OAuthProvider, SubstituteConfig, TokenEntry |
| `src/auth/discovery-loader.ts` | **new** | Parse discovery JSONs → OAuthProvider[] |
| `src/auth/token-substitute.ts` | **new** | Format-preserving token mangling engine |
| `src/auth/universal-oauth-handler.ts` | **new** | HostHandler factory, dispatches by mode |
| `src/auth/discovery-loader.test.ts` | **new** | Tests: fixed/templated/split-host parsing |
| `src/auth/token-substitute.test.ts` | **new** | Tests: generation, restriction, revocation |
| `src/auth/universal-oauth-handler.test.ts` | **new** | Tests: bearer-swap, token-exchange, authorize-stub |
| `src/credential-proxy.ts` | **modify** | Add anchorSet for Level 1 O(1), registerAnchor() |
| `src/auth/registry.ts` | **modify** | Add registerDiscoveryProviders() |
| `src/auth/index.ts` | **modify** | Export registerDiscoveryProviders |
| `src/index.ts` | **modify** | Call registerDiscoveryProviders() at startup |
| `src/oauth-interceptor.ts` | **no change** | Reused as-is by universal handler |

## Implementation Order

1. `oauth-types.ts` — types only
2. `token-substitute.ts` + tests — self-contained, no deps on proxy
3. `discovery-loader.ts` + tests — reads files, produces data structures
4. `credential-proxy.ts` — add anchorSet
5. `universal-oauth-handler.ts` + tests — wires token engine + oauth-interceptor
6. `registry.ts` + `index.ts` + `auth/index.ts` — startup wiring
7. Verify all existing tests pass (no regressions)

## Verification

1. `npm run build` — clean compile
2. `npx vitest run` — all existing tests pass
3. New tests cover:
   - Discovery loader: parse anthropic.json (fixed, split-host), auth0.json (templated), google.json (multi-host), zendesk.json (scoped attrs)
   - Token engine: format preservation for `sk-ant-*`, `ya29.*`, `ghp_*` patterns; MIN_RANDOM_CHARS rejection; attr restriction
   - Universal handler: mock upstream, verify bearer-swap injects real token, token-exchange returns substitutes, attr restriction blocks cross-tenant
4. Claude provider continues to work (built-in provider overrides discovery rules)
