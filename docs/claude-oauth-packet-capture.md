# Claude Code OAuth — Packet Capture Reference

Captured via transparent TLS MITM proxy intercepting all HTTPS traffic
from a Docker container running `claude auth login` and `claude -p`.

CLI version: **2.1.74**, captured **2026-03-13**.

---

## Hosts Involved

| Host | Purpose |
|------|---------|
| `claude.ai` | OAuth authorization page (browser, user-facing) |
| `platform.claude.com` | Token exchange and refresh (`/v1/oauth/token`) |
| `api.anthropic.com` | All API calls: messages, profile, telemetry |

---

## Phase 1: OAuth Authorization (Browser)

The CLI generates **two URLs** with the same `code_challenge`/`state` but different `redirect_uri`:

### URL passed to xdg-open (localhost callback)

```
GET https://claude.ai/oauth/authorize
  ?code=true
  &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
  &response_type=code
  &redirect_uri=http%3A%2F%2Flocalhost%3A{PORT}%2Fcallback
  &scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers
  &code_challenge={CHALLENGE}
  &code_challenge_method=S256
  &state={STATE}
```

### Fallback URL printed to stdout (code display page)

```
GET https://claude.ai/oauth/authorize
  ?code=true
  &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
  &response_type=code
  &redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback
  &scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers
  &code_challenge={CHALLENGE}
  &code_challenge_method=S256
  &state={STATE}
```

### Authorization parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `client_id` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | Fixed, identifies Claude Code app |
| `response_type` | `code` | Standard authorization code flow |
| `scope` | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers` | Space-separated |
| `code_challenge_method` | `S256` | PKCE with SHA-256 |
| `code_challenge` | per-session | `SHA256(code_verifier)`, base64url-encoded |
| `state` | per-session | CSRF protection, base64url-encoded |

### Callback

After user authorizes, browser redirects to:

```
HTTP 302 → http://localhost:{PORT}/callback?code={AUTH_CODE}&state={STATE}
```

The CLI's local HTTP server receives this and responds **302**.

---

## Phase 2: Token Exchange

Immediately after receiving the callback.

### Request

```
POST https://platform.claude.com/v1/oauth/token
```

**Request headers:**
```
accept: (default)
content-type: application/json
user-agent: (CLI user agent string)
content-length: (body length)
host: platform.claude.com
```

No `authorization` header — this is a public client using PKCE.

**Request body:**
```json
{
  "grant_type": "authorization_code",
  "code": "OlK7snFP4boTUd5wkoDyDccA1k4mLa426LSrpJatk3w3QO5r",
  "redirect_uri": "http://localhost:42159/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "7LQBWRFiBtynXbHv-ssyR2lbgZ1cYC7u5FLDDz6C3vo",
  "state": "-02IGcnA6s1WcetGPEHLLJzgHsTPMVkUo7JxyPQkQ4Q"
}
```

| Field | Description |
|-------|-------------|
| `grant_type` | `authorization_code` for initial login |
| `code` | Authorization code from the callback URL |
| `redirect_uri` | Must match the one in the authorize request exactly |
| `client_id` | Same as authorize request |
| `code_verifier` | PKCE verifier string (unhashed), ~43 chars |
| `state` | Must match the state from authorize request |

### Response

**Status:** 200

```json
{
  "token_type": "Bearer",
  "access_token": "sk-ant-oat01-gofL2JaEK3OXP0nZL8zwzj...",
  "expires_in": 28800,
  "refresh_token": "sk-ant-ort01-L3Y3Jhsb97x_aaswggCA5u...",
  "scope": "user:inference user:mcp_servers user:profile user:sessions:claude_code",
  "organization": {
    "uuid": "017a9239-4379-4d86-893a-3aec1b5a8311",
    "name": "..."
  },
  "account": {
    "uuid": "39d22b02-1d6a-4185-97c6-df88f26a8df7",
    "email_address": "..."
  }
}
```

| Field | Value | Notes |
|-------|-------|-------|
| `token_type` | `Bearer` | Always |
| `access_token` | `sk-ant-oat01-...` | ~100 chars, valid for `expires_in` seconds |
| `expires_in` | `28800` | 8 hours |
| `refresh_token` | `sk-ant-ort01-...` | ~100 chars, long-lived |
| `scope` | space-separated string | May differ from requested scopes |
| `organization` | `{uuid, name}` | User's org |
| `account` | `{uuid, email_address}` | User's account |

---

## Phase 3: Stored Credentials

The CLI writes `~/.claude/.credentials.json` immediately after token exchange:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-gofL2JaEK3OXP0nZL8zwzj...",
    "refreshToken": "sk-ant-ort01-L3Y3Jhsb97x_aaswggCA5u...",
    "expiresAt": 1773451225012,
    "scopes": [
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code"
    ],
    "subscriptionType": "max",
    "rateLimitTier": "default_claude_max_5x"
  }
}
```

### Field mapping (token exchange response → credentials file)

| credentials.json field | Source | Transform |
|------------------------|--------|-----------|
| `accessToken` | response `access_token` | verbatim |
| `refreshToken` | response `refresh_token` | verbatim |
| `expiresAt` | response `expires_in` | `Date.now() + expires_in * 1000` (epoch ms) |
| `scopes` | response `scope` | split on space → array |
| `subscriptionType` | profile response `organization_type` | mapped (e.g. `claude_max` → `max`) |
| `rateLimitTier` | profile response `rate_limit_tier` | verbatim |

---

## Phase 4: Post-Login Verification

After storing credentials, the CLI makes three API calls to verify the account.
All use `Authorization: Bearer {access_token}`.

### 4a. Profile

```
GET https://api.anthropic.com/api/oauth/profile
```

**Request headers:**
```
accept: (default)
content-type: application/json
authorization: Bearer sk-ant-oat01-...
user-agent: (CLI UA)
host: api.anthropic.com
```

**Response (200):**
```json
{
  "account": {
    "uuid": "39d22b02-1d6a-4185-97c6-df88f26a8df7",
    "full_name": "KI",
    "display_name": "KI",
    "email": "...",
    "has_claude_max": true,
    "has_claude_pro": false,
    "created_at": "2025-02-06T07:42:48.902499Z"
  },
  "organization": {
    "uuid": "017a9239-4379-4d86-893a-3aec1b5a8311",
    "name": "...",
    "organization_type": "claude_max",
    "billing_type": "stripe_subscription",
    "rate_limit_tier": "default_claude_max_5x",
    "has_extra_usage_enabled": false,
    "subscription_status": "active",
    "subscription_created_at": "2025-08-14T17:24:20.947281Z"
  },
  "application": {
    "uuid": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    "name": "Claude Code",
    "slug": "claude-code"
  }
}
```

### 4b. Roles

```
GET https://api.anthropic.com/api/oauth/claude_cli/roles
```

**Request headers:**
```
accept: (default)
authorization: Bearer sk-ant-oat01-...
user-agent: (CLI UA)
host: api.anthropic.com
```

**Response (200):**
```json
{
  "organization_uuid": "017a9239-4379-4d86-893a-3aec1b5a8311",
  "organization_name": "...",
  "organization_role": "admin",
  "workspace_uuid": null,
  "workspace_name": null,
  "workspace_role": null
}
```

### 4c. First Token Date

```
GET https://api.anthropic.com/api/organization/claude_code_first_token_date
```

**Request headers:**
```
accept: (default)
authorization: Bearer sk-ant-oat01-...
anthropic-beta: (present)
user-agent: (CLI UA)
host: api.anthropic.com
```

**Response (200):**
```json
{
  "first_token_date": "2025-07-17T19:23:42.841160Z"
}
```

After these three succeed, CLI prints **"Login successful."** and exits 0.

---

## Phase 5: API Usage (`claude -p`)

When running `claude -p "prompt"`, the following requests are made:

### 5a. SDK Eval (feature flags)

```
POST https://api.anthropic.com/api/eval/sdk-{EVAL_ID}
```

**Request headers:**
```
authorization: Bearer sk-ant-oat01-...
```

**Response:** 200

### 5b. Messages (the actual API call)

```
POST https://api.anthropic.com/v1/messages?beta=true
```

**Request headers:**
```
authorization: Bearer sk-ant-oat01-...
content-type: application/json
anthropic-version: (present)
anthropic-beta: (present)
```

**Response:** 200, streamed (SSE)

### 5c. Event Logging (telemetry, fire-and-forget)

```
POST https://api.anthropic.com/api/event_logging/batch
```

**Request headers:**
```
accept: (default)
content-type: application/json
user-agent: (CLI UA)
x-service-name: (present)
host: api.anthropic.com
```

Note: **No `authorization` header** on event logging.

**Response (200):**
```json
{"accepted_count": 2, "rejected_count": 0}
```

---

## Phase 6: Token Refresh (expected, not yet captured)

When `expiresAt` from `.credentials.json` is in the past, the CLI should
attempt refresh **before** making API calls.

### Expected request

```
POST https://platform.claude.com/v1/oauth/token
```

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "sk-ant-ort01-...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

### Expected response

Same structure as initial token exchange — new `access_token`, possibly
rotated `refresh_token`, new `expires_in`.

### Behavior notes

- The CLI checks `expiresAt` proactively, does **not** retry on 401
- `CLAUDE_CODE_OAUTH_TOKEN` env var bypasses `.credentials.json` entirely
  (no expiry check, no refresh attempt)
- Without the env var AND without valid `.credentials.json`, CLI prints
  "Not logged in" and exits

---

## Token Prefixes

| Prefix | Type | Lifetime |
|--------|------|----------|
| `sk-ant-oat01-` | OAuth access token | 8 hours |
| `sk-ant-ort01-` | OAuth refresh token | long-lived |
| `sk-ant-api00-` | API key | permanent |

---

## API Key Mode (non-OAuth)

When `ANTHROPIC_API_KEY` is set (instead of OAuth), the CLI uses
`x-api-key` header instead of `Authorization: Bearer`:

```
POST https://api.anthropic.com/v1/messages
x-api-key: sk-ant-api00-...
```

The `x-api-key` header is **never** used in OAuth mode. The two auth
modes are mutually exclusive:

| Env var | Header on API calls | Token exchange |
|---------|--------------------|----|
| `ANTHROPIC_API_KEY` | `x-api-key: sk-ant-api00-...` | None |
| `CLAUDE_CODE_OAUTH_TOKEN` | `Authorization: Bearer sk-ant-oat01-...` | `platform.claude.com/v1/oauth/token` |

---

## Proxy Interception Summary

| Host | Path | Method | Auth in request | Proxy action |
|------|------|--------|-----------------|--------------|
| `platform.claude.com` | `/v1/oauth/token` | POST | None (PKCE) | Buffer body both directions: swap refresh_token out, capture tokens in |
| `api.anthropic.com` | `/v1/messages*` | POST | `Authorization: Bearer` | Swap Bearer token in header |
| `api.anthropic.com` | `/api/oauth/*` | GET | `Authorization: Bearer` | Swap Bearer token in header |
| `api.anthropic.com` | `/api/eval/*` | POST | `Authorization: Bearer` | Swap Bearer token in header |
| `api.anthropic.com` | `/api/event_logging/*` | POST | None | Pass through (no credentials) |
| `api.anthropic.com` | `/api/organization/*` | GET | `Authorization: Bearer` | Swap Bearer token in header |
