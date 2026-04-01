# Plan: Extend /auth Command for Key Management

## Context

The `/auth` command currently ignores args and always triggers the full interactive reauth menu (Claude-only). We need to extend it so users can manage credentials for any provider — Claude and discovery-file providers alike.

## Scenarios

| Command | Behavior |
|---------|----------|
| `/auth` or `/auth claude` | Existing reauth menu (unchanged) |
| `/auth <provider>` | Interactive GPG-based key setup (send/receive flow via ChatIO) |
| `/auth <provider> set-key [role] [expiry=N] <pgp block>` | Non-interactive: decrypt PGP, store key |
| `/auth <provider> delete` | Delete all credentials for provider in group's scope |
| `/auth-gpg` | Print GPG public key for this group's scope (sent raw, no prefix) |

**Provider eligibility for (b):** a parsed `OAuthProvider` qualifies if it has bearer-swap rules (from `api_base_url`/`_api_hosts`). Without these, there's no API surface to intercept.

**Role determination** is layered (additive, not exclusive):
1. Existing keys/refs in the token engine for this provider → those roles are in use
2. `envVars` values on the `OAuthProvider` → declared role mappings
3. Fall back to `'access'`

## Files to Modify

| File | Change |
|------|--------|
| `src/commands.ts` | Extend `auth` handler, add `auth-gpg`, fix multiline regex, add `runKeySetup`/`sendRawMessage` to CommandResult |
| `src/auth/registry.ts` | Retain discovery provider map + dir at module level, export getters |
| `src/auth/key-management.ts` | **New file** — eligibility check, interactive setup flow, set-key, delete |
| `src/index.ts` | Wire `runKeySetup`, `sendRawMessage`, and `providerId` callbacks |

## Step 1: Expose discovery metadata — `src/auth/registry.ts`

`registerDiscoveryProviders()` builds a `Map<string, OAuthProvider>` locally and discards it. Retain at module level and export:

```typescript
let _discoveryDir = '';
let _discoveryProviders = new Map<string, OAuthProvider>();

// Inside registerDiscoveryProviders():
_discoveryDir = dir;
_discoveryProviders = providers;

// New exports:
export function getDiscoveryProvider(id: string): OAuthProvider | undefined
export function getDiscoveryDir(): string
export function getAllDiscoveryProviderIds(): string[]
```

## Step 2: Create `src/auth/key-management.ts`

### `isKeyEligibleProvider(providerId: string): boolean`

Uses `getDiscoveryProvider(providerId)` to get the parsed `OAuthProvider`. Eligible if it has rules with `mode === 'bearer-swap'` (provider has API surface from `api_base_url` / `_api_hosts`). Without bearer-swap rules there's nothing to intercept.

### `getProviderRoles(providerId: string, groupScope: GroupScope, tokenEngine: TokenSubstituteEngine): Set<'access' | 'api_key'>`

Collects known roles from additive sources (excluding `refresh` — it's attached to `access` and can't be set by the user):
1. **Existing keys/refs** in the token engine for this provider/scope
2. **`envVars`** values on the `OAuthProvider` (filtered to `access`/`api_key`)
3. Empty set if neither source yields anything

### `storeProviderKey(providerId, credScope, groupScope, role, token, expiresTs, tokenEngine): { needsRestart: boolean }`

Generalized from Claude's `storeResult` pattern (`claude.ts:837-885`):
1. Check if the stored role has an associated env var (via `OAuthProvider.envVars`) that had no substitute yet (i.e. `getOrCreateSubstitute` would have returned null before) — meaning the env var was never populated into a running container.
2. `tokenEngine.clearCredentials(groupScope, providerId)` — wipe old keys (handles `access`/`api_key` mutual exclusivity)
3. `resolver.store(token, providerId, credScope, role, expiresTs)`
4. `tokenEngine.pruneStaleRefs(groupScope, providerId)` — clean up orphaned refs
5. Return `{ needsRestart }` — true if step 1 found an env var that wasn't yet populated.

Callers (interactive setup + `set-key`) append a restart notice to the success message when `needsRestart` is true: "Container restart may be needed for the new key to take effect."

This replaces inline store calls in both interactive setup and `set-key`.

### `runInteractiveKeySetup(providerId: string, groupScope: GroupScope, tokenEngine: TokenSubstituteEngine, chat: ChatIO): Promise<boolean>`

Scenario (b). Uses `ChatIO` for the interactive send/receive cycle:
1. Validate eligibility via `isKeyEligibleProvider()`
2. Determine roles via `getProviderRoles()` — if no roles found, tell user this provider is not configured for manual key setup and return false. If multiple roles, ask user to choose (numbered menu via `chat.send` + `chat.receive`). If single role, use it directly.
3. Check `isGpgAvailable()` → error if missing
4. `ensureGpgKey(scope)` + `exportPublicKey(scope)`
5. `chat.sendRaw(pubKey)` (no prefix, directly copy-pasteable)
6. `chat.send(instructions)` — how to encrypt and paste back
7. `reply = chat.receive(timeout)` — wait for PGP block
8. `chat.hideMessage()` + `chat.advanceCursor()` — don't leak to agent
9. Validate `isPgpMessage(reply)`, decrypt via `gpgDecrypt(scope, reply)`
10. Store via `storeProviderKey(...)` (clears old → stores new → prunes stale refs)
11. Return true/false

This mirrors the existing Claude API key flow in `claude.ts:984-1075`.

### `handleSetKey(providerId: string, argsAfterSetKey: string, groupScope: GroupScope, tokenEngine: TokenSubstituteEngine): string`

Scenario (c). Synchronous (no ChatIO needed):
1. Parse args: find `-----BEGIN PGP MESSAGE-----` (may be on a subsequent line after role/expiry tokens). Everything from that marker onward is the PGP block.
2. Before PGP marker: scan for optional role (`access` | `api_key`), optional `expiry=<int>`
3. Defaults: role from `getProviderRoles()` (single role → use it; multiple → first; empty → `'access'`), expiry = 0
4. Validate PGP block via `isPgpMessage()`
5. Decrypt via `gpgDecrypt(String(groupScope), pgpBlock)`
6. Get credential scope: `asCredentialScope(String(groupScope))` — always write to own scope
7. Store via `storeProviderKey(...)` (clears old → stores new → prunes stale refs)
8. Return success message string

**Note on PGP block position:** The PGP message may start on the same line as other args or on a new line (e.g. when pasted from clipboard). Use `args.indexOf('-----BEGIN PGP MESSAGE-----')` to split regardless of line boundaries.

### `handleDeleteKeys(providerId: string, groupScope: GroupScope, tokenEngine: TokenSubstituteEngine): string`

Scenario (d):
1. `tokenEngine.revokeByScope(groupScope, providerId)` — handles scope resolution, hot cache, keys file cleanup
2. Return confirmation message

## Step 3: Fix multiline regex — `src/commands.ts`

Line 84: `.` doesn't match newlines, truncating multiline PGP in args.

```typescript
// Before:
const COMMAND_RE = /^\/([a-zA-Z0-9-]+)(?:\s+(.*))?$/;
// After:
const COMMAND_RE = /^\/([a-zA-Z0-9-]+)(?:\s+([\s\S]*))?$/;
```

## Step 4: Extend types + commands — `src/commands.ts`

### `CommandResult` — add `runKeySetup`, change `runReauth` to string

```typescript
export interface CommandResult {
  stopContainer?: boolean;
  runReauth?: string;             // was: boolean — now provider ID string (use CLAUDE_PROVIDER_ID)
  runKeySetup?: string;           // new: provider ID for interactive key setup
  asyncAction?: () => Promise<string | undefined>;
  sendRawMessage?: string;        // new: sent without formatting/prefix (for GPG keys)
}
```

### Rewrite `auth` handler

Uses `CLAUDE_PROVIDER_ID` constant (already imported at line 23 from `./auth/providers/claude.js`).

```typescript
auth: {
  description: 'Manage authentication — /auth [provider] [set-key|delete]',
  run(args, ctx) {
    // (a) No args or "claude" → existing reauth
    if (!args || args === CLAUDE_PROVIDER_ID) {
      return { stopContainer: true, runReauth: CLAUDE_PROVIDER_ID };
    }

    const firstLine = args.split('\n')[0];
    const parts = firstLine.trim().split(/\s+/);
    const providerId = parts[0];

    // Validate provider exists in discovery registry
    if (!getDiscoveryProvider(providerId)) {
      const known = getAllDiscoveryProviderIds();
      return reply(
        `Unknown provider: ${providerId}\n` +
        `Known providers: ${known.join(', ')}`,
      );
    }

    const subcommand = parts[1]?.toLowerCase();

    // (d) /auth <provider> delete
    if (subcommand === 'delete') {
      return {
        asyncAction: async () =>
          handleDeleteKeys(providerId, scopeOf(ctx.group), ctx.tokenEngine),
      };
    }

    // (c) /auth <provider> set-key [role] [expiry=N] <pgp block>
    if (subcommand === 'set-key') {
      const rest = args.slice(args.indexOf('set-key') + 7).trim();
      return {
        asyncAction: async () =>
          handleSetKey(providerId, rest, scopeOf(ctx.group), ctx.tokenEngine),
      };
    }

    // (b) /auth <provider> → interactive key setup (needs ChatIO)
    return { runKeySetup: providerId };
  },
},
```

### Add `auth-gpg` command

GPG key is sent raw (no prefix/formatting) via `sendRawMessage` so it's directly copy-pasteable.

```typescript
'auth-gpg': {
  description: 'Print GPG public key for this group',
  run(_args, ctx) {
    if (!isGpgAvailable()) return reply('GPG is not available. Install gnupg first.');
    const scope = String(scopeOf(ctx.group));
    ensureGpgKey(scope);
    return { sendRawMessage: exportPublicKey(scope) };
  },
},
```

## Step 5: Wire new result fields in `executeCommand` — `src/commands.ts`

Update line 345 and add handling for `runKeySetup` and `sendRawMessage`:

```typescript
if (result.sendRawMessage) await ctx.sendRawMessage(result.sendRawMessage);
if (result.asyncAction) {
  const msg = await result.asyncAction();
  if (msg) await ctx.sendMessage(msg);
}
if (result.runReauth) await ctx.runReauth(result.runReauth);
if (result.runKeySetup) await ctx.runKeySetup(result.runKeySetup);
```

### `CommandContext` — add fields

```typescript
export interface CommandContext {
  // ... existing fields ...
  sendRawMessage: (text: string) => Promise<void>;      // new: send without prefix
  runReauth: (providerId: string) => Promise<void>;     // was: () => Promise<void>
  runKeySetup: (providerId: string) => Promise<void>;   // new
}
```

## Step 6: Wire callbacks in `src/index.ts`

In the `CommandContext` construction (around line 232-252):

```typescript
sendRawMessage: (text) => channel.sendMessage(chatJid, text),
runReauth: async (providerId: string) => {
  const chat = createChatIO(chatIODeps(channel, chatJid));
  await runReauth(scopeOf(group), chat, 'User requested auth', providerId, getTokenEngine());
},
runKeySetup: async (providerId: string) => {
  const chat = createChatIO(chatIODeps(channel, chatJid));
  await runInteractiveKeySetup(providerId, scopeOf(group), getTokenEngine(), chat);
},
```

New import: `import { runInteractiveKeySetup } from './auth/key-management.js';`

## Reusable code

| What | Where | Reuse in |
|------|-------|----------|
| `isGpgAvailable`, `ensureGpgKey`, `exportPublicKey`, `gpgDecrypt`, `isPgpMessage` | `src/auth/gpg.ts` | key-management.ts, commands.ts (auth-gpg) |
| `asCredentialScope`, `GroupScope`, `CredentialScope` | `src/auth/oauth-types.ts` | key-management.ts |
| `CLAUDE_PROVIDER_ID` | `src/auth/providers/claude.ts` | commands.ts (already imported as `PROVIDER_ID`) |
| `TokenSubstituteEngine.revokeByScope()` | `src/auth/token-substitute.ts` | key-management.ts (delete) |
| `TokenResolver.store()` | `src/auth/oauth-types.ts` | key-management.ts (set-key, interactive) |
| `createChatIO`, `ChatIODeps` | `src/auth/chat-io.ts` | index.ts (runKeySetup wiring) |
| `ChatIO` interface | `src/auth/types.ts` | key-management.ts (interactive setup) |
| `scopeOf()` | `src/types.ts` | commands.ts |

## Verification

1. `npm run build` — no type errors
2. `/auth` and `/auth claude` → triggers existing reauth menu (unchanged)
3. `/auth github` → interactive: sends GPG key (raw), waits for encrypted reply, decrypts, stores
4. `/auth github set-key -----BEGIN PGP MESSAGE-----...` → decrypts and stores (default role)
5. `/auth github set-key api_key expiry=3600\n-----BEGIN PGP MESSAGE-----...` → PGP on next line works
6. `/auth github delete` → deletes credentials, confirms
7. `/auth-gpg` → sends raw ASCII-armored GPG public key (no prefix/formatting)
8. `/auth nonexistent` → error message listing known providers
9. Multiline PGP in args captured correctly after regex fix
