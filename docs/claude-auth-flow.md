# Claude CLI Authentication Flows

How the Claude Code CLI authenticates API requests, and what the proxy must handle.

## Auth Modes

### API Key Mode

Container env: `ANTHROPIC_API_KEY=placeholder`

Single flow — every request goes to `api.anthropic.com`:

```
CLI → api.anthropic.com/v1/messages
     Header: x-api-key: placeholder
     Proxy swaps: x-api-key: <real-api-key>
```

No other endpoints involved. No refresh. No expiry.

### OAuth Mode

Container env: `CLAUDE_CODE_OAUTH_TOKEN=placeholder`

Three distinct flows involving two hosts:

#### 1. Initial token acquisition (login)

Happens at `console.anthropic.com`, not `api.anthropic.com`.

```
CLI → console.anthropic.com/api/oauth/token
     POST, Content-Type: application/json
     Body: { grant_type: "authorization_code", code: "...", ... }
     Response: {
       access_token: "sk-ant-oat01-...",     // expires in 8 hours
       refresh_token: "sk-ant-ort01-...",
       expires_in: 28800,
       token_type: "Bearer"
     }
```

In NanoClaw, this flow is handled by the auth provider's `runOAuthFlow()` on the host side (spawns a container with `claude auth login`). The tokens are stored encrypted in the credential store. The container never sees real tokens.

#### 2. API calls

```
CLI → api.anthropic.com/v1/messages
     Header: Authorization: Bearer placeholder
     Proxy swaps: Authorization: Bearer <real-access-token>
```

The OAuth token is used directly as a Bearer token. There is no exchange to get an `x-api-key` — the `Authorization: Bearer` header IS the credential.

#### 3. Token refresh

Access tokens expire after 8 hours. The CLI refreshes via:

```
CLI → console.anthropic.com/api/oauth/token
     POST, Content-Type: application/json
     Body: {
       grant_type: "refresh_token",
       refresh_token: "placeholder",          // or substitute
       client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
     }
     Response: {
       access_token: "sk-ant-oat01-...",      // new token
       refresh_token: "sk-ant-ort01-...",      // possibly rotated
       expires_in: 28800
     }
```

The proxy must:
- Swap the placeholder/substitute refresh token in the request body with the real one
- Intercept the response to capture the new real tokens
- Return substitute tokens to the container

This is a **token-exchange** (body buffered both directions), not a simple header swap.

## Proxy Implications

### What `injectCredentials` (header-only swap) can handle

- API key mode: all requests (x-api-key swap)
- OAuth API calls: bearer swap on `api.anthropic.com`

### What requires oauth-interceptor (body buffering)

- Token refresh on `console.anthropic.com/api/oauth/token`
  - Outbound: swap substitute refresh_token → real refresh_token
  - Inbound: capture real tokens, return substitutes

### Hosts the transparent proxy must intercept

| Host | When | Mode |
|------|------|------|
| `api.anthropic.com` | Always | headers-only (x-api-key or Bearer swap) |
| `console.anthropic.com` | OAuth refresh | token-exchange (body both directions) |

### Setup token (`claude setup-token`)

Produces a long-lived `sk-ant-oat01-...` token (valid ~1 year). Same as OAuth access_token in format. Used the same way — `Authorization: Bearer` on API calls. No refresh flow needed (it doesn't expire in practice).

## Token Formats

| Token | Prefix | Lifetime | Usage |
|-------|--------|----------|-------|
| API key | `sk-ant-api...` | Permanent | `x-api-key` header |
| OAuth access token | `sk-ant-oat01-...` | 8 hours | `Authorization: Bearer` header |
| OAuth refresh token | `sk-ant-ort01-...` | Long-lived | POST body to token endpoint |
| Setup token | `sk-ant-oat01-...` | ~1 year | `Authorization: Bearer` header |
