# Claude OAuth Token Refresh

Captured 2026-03-28 via MITM tap on a NanoClaw container running Claude Code interactively.

## Endpoint

```
POST https://platform.claude.com/v1/oauth/token
```

## Request

**Headers:**
```
Content-Type: application/json
User-Agent: axios/1.13.6
Accept: application/json, text/plain, */*
```

No `Authorization` header — the refresh token is in the body.

**Body:**
```json
{
  "grant_type": "refresh_token",
  "refresh_token": "sk-ant-ort01-...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

| Field | Value | Notes |
|-------|-------|-------|
| `grant_type` | `refresh_token` | Standard OAuth2 refresh grant |
| `refresh_token` | `sk-ant-ort01-...` | One-use. Burned after exchange. |
| `client_id` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | Fixed Claude Code app ID. Same as in the initial OAuth authorize flow (see `claude-oauth-packet-capture.md`). |
| `scope` | space-separated list | Requested scopes for the new token |

## Response (200)

**Headers:**
```
Content-Type: application/json
Cache-Control: no-store
Pragma: no-cache
```

**Body:**
```json
{
  "token_type": "Bearer",
  "access_token": "sk-ant-oat01-...",
  "expires_in": 28800,
  "refresh_token": "sk-ant-ort01-...",
  "scope": "user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code",
  "organization": {
    "uuid": "fda5ed98-f76b-4a32-a81d-a7194beaae62",
    "name": "...@gmail.com's Organization"
  },
  "account": {
    "uuid": "d343259f-7427-4be7-8d98-6524924f8857",
    "email_address": "...@gmail.com"
  }
}
```

| Field | Notes |
|-------|-------|
| `access_token` | New `sk-ant-oat01-...` token. Prefix identifies it as an OAuth access token. |
| `expires_in` | 28800 seconds = 8 hours |
| `refresh_token` | New `sk-ant-ort01-...` token. Previous one is now invalid (one-use rotation). |
| `scope` | Granted scopes (may differ from requested) |
| `organization` | Organization the token belongs to |
| `account` | Account details |

## Token Lifecycle

1. Initial OAuth login produces `access_token` + `refresh_token`, stored in `~/.claude/.credentials.json`
2. Access token expires after `expires_in` seconds (8 hours observed)
3. Claude CLI detects expiry on startup (interactive mode only — `-p` flag does NOT trigger refresh)
4. CLI sends refresh request to `platform.claude.com/v1/oauth/token`
5. Server returns new access + refresh tokens (one-use rotation)
6. CLI writes updated tokens to `.credentials.json`

## Error Response (400)

When the refresh token has already been consumed:
```json
{
  "error": "invalid_grant",
  "error_description": "refresh token has been used"
}
```

## Notes

- The `client_id` is the same fixed UUID used throughout the Claude Code OAuth flow (authorize, token exchange, refresh). It identifies the Claude Code application, not the user. It is NOT sent in `/v1/messages` API calls — those authenticate solely via `Authorization: Bearer` header.
- Refresh tokens are one-use: each successful refresh returns a new refresh token and invalidates the old one.
- The access token prefix `sk-ant-oat01-` indicates OAuth access token. The refresh token prefix `sk-ant-ort01-` indicates OAuth refresh token.
- Claude Code uses `axios/1.13.6` as the HTTP client for token operations (not the Anthropic SDK).
