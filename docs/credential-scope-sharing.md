# Replace "default" Credential Scope with Named Scope Sharing

## Context

The current credential system has a hardcoded `DEFAULT_CREDENTIAL_SCOPE = 'default'` that serves as a shared fallback. Groups opt in via the boolean `useDefaultCredentials` flag. This is rigid: groups can only borrow from the single "default" scope, and the main group implicitly "owns" it.

This feature replaces that with **arbitrary named scope sharing**: any group's credential scope can be shared with any other group. Each group has at most one credential source (single fallback). The "default" scope concept is removed entirely.

---

## Data Model Changes

### 1. `src/types.ts` — Replace `useDefaultCredentials` with bilateral sharing fields

```typescript
interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  credentialSource?: string;    // folder name of the group to borrow from (borrower side)
  credentialGrantees?: string[]; // folder names of groups granted access (grantor side)
}
```

**Access rule**: A borrower can only access the source scope if BOTH conditions hold:
- Borrower's `credentialSource` points to the grantor
- Grantor's `credentialGrantees` includes the borrower

The grantor's list is authoritative — a borrower cannot access credentials it hasn't been explicitly granted.

### 2. `src/auth/oauth-types.ts` — Remove `DEFAULT_CREDENTIAL_SCOPE`

Delete the constant and its usage. `CredentialScope` type stays (it's still used for all scopes).

### 3. `src/config.ts` — Keep `NEW_GROUPS_USE_DEFAULT_CREDENTIALS`

Repurposed: when true (default), registering a new group automatically performs grant from main + borrow on the new group (adds new group to main's `credentialGrantees`, sets new group's `credentialSource` to main's folder, creates `borrowed` symlink, distributes manifests).

---

## Core Engine Changes

### 4. `src/auth/token-substitute.ts` — Update `resolveCredentialScopeInternal` (line 653)

**Current**: checks `useDefaultCredentials` boolean, falls back to hardcoded `DEFAULT_CREDENTIAL_SCOPE`.

**New logic**:
```
1. Check own scope — if has keys, return { ownScope, writable: true }
2. Check group.containerConfig.credentialSource — if set and source scope has keys,
   return { sourceScope, writable: false }
3. Return { ownScope, writable: true } (no keys anywhere, will trigger reauth)
```

Remove the `defaultScope` parameter. Remove special `isMain` treatment — main is just a group with its own scope.

Note: `resolveCredentialScopeInternal` only checks `credentialSource` for resolution (does the scope have keys?). The bilateral access check (is the borrower listed in the grantor's `credentialGrantees`?) is enforced separately in `createAccessCheck`, which is called by `resolveSubstitute` at proxy request time. This means a misconfigured borrower (not yet granted) can get substitutes generated at container startup, but those substitutes will be rejected at request time — triggering reauth.

### 5. `src/auth/provision.ts` — Update `createAccessCheck` (line 70)

**Current**: special-cases `sourceScope === 'default'`, checks `useDefaultCredentials`.

**New logic** — bilateral check (both sides must agree):
```typescript
(groupScope, sourceScope) => {
  // Own scope: always allowed
  if ((groupScope as string) === (sourceScope as string)) return true;

  const borrower = groupResolver(groupScope);
  if (!borrower) return false;

  // Borrower must claim this source
  if (borrower.containerConfig?.credentialSource !== (sourceScope as string)) return false;

  // Grantor must have listed this borrower
  const grantor = groupResolver(asGroupScope(sourceScope as string));
  if (!grantor) return false;
  return grantor.containerConfig?.credentialGrantees?.includes(groupScope as string) === true;
}
```

This ensures a borrower **cannot** access credentials unless the grantor has explicitly listed them in `credentialGrantees`.

### 6. `src/auth/provision.ts` — Rename `importEnvToDefault` to `importEnvToMainGroup`

Accept `mainGroupFolder: string` param. Import credentials into the main group's scope instead of `'default'`.

### 7. `src/auth/init.ts` — Update startup wiring (line 94)

- Look up the main group from `getGroups()`
- Call `importEnvToMainGroup(tokenEngine, mainFolder)` instead of `importEnvToDefault`
- Remove `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` import and re-export

### 8. `src/index.ts` — Update `registerGroup` (line 158)

Replace the old `useDefaultCredentials` assignment with the new auto-grant/borrow flow when `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` is true:
1. Add the new group's folder to main group's `credentialGrantees`
2. Set the new group's `credentialSource` to main's folder
3. Save both groups to DB
4. Create `borrowed` symlink in new group's credentials folder
5. Async-distribute all of main's manifests to the new group

---

## Command UX

### 11. New file: `src/commands/creds-commands.ts`

Register with the command registry (pattern from `auth-commands.ts`).

| Command | Action |
|---------|--------|
| `/creds` | Show current group's credential status: own providers, credential source, list of grantees |
| `/creds share <target-folder>` | **Unilateral (grantor only)**: adds target to this group's `credentialGrantees`. Does NOT touch the target's `credentialSource` — the borrower must separately run `/creds borrow`. |
| `/creds borrow <source-folder>` | Sets own `credentialSource`. Only effective if the source has already granted via `credentialGrantees`. If not yet granted, sets the field but warns that access is pending grantor approval. |
| `/creds revoke <target-folder>` | Removes target from this group's `credentialGrantees`. Does NOT clear target's `credentialSource` — borrower decides that. Revokes borrowed substitutes for the target. |
| `/creds stop-borrowing` | Clears own `credentialSource`. Does NOT remove self from grantor's grantee list (grantor decides that). |

**Access control**:
- `share` and `revoke`: caller must be in the main group OR the grantor group itself
- `borrow` and `stop-borrowing`: can run from any group (self-service)
- Validate that referenced group folder exists in `registered_groups`

**Side effects**: After modifying sharing, revoke stale borrowed substitutes for affected groups and regenerate credential info files. Update both groups' `ContainerConfig` in DB via `setRegisteredGroup`.

---

## Credential Visibility: Grantor Manifest Propagation

### Problem

The agent discovers credentials via `{groupFolder}/credentials/tokens/{providerId}.jsonl`, populated from substitutes at container startup. Between grant establishment and next container run, the borrower's agent has no visibility into what the grantor offers. Grantor credential changes also go unnoticed.

### Design: Manifest files with async `cp` distribution

#### Manifest Format (JSONL, one line per credential)
```jsonl
{"provider":"claude","name":"oauth","credScope":"main"}
{"provider":"claude","name":"api_key","credScope":"main"}
```

#### Folder Structure

Source (grantor, in credential store):
```
~/.config/nanoclaw/credentials/{scope}/manifests/{providerId}.jsonl
```

Destination (grantee's group folder, distributed by grantor):
```
groups/{granteeFolder}/credentials/granted/{grantorFolder}/{providerId}.jsonl
```

Symlink (created by `/creds borrow`, agent reads from here):
```
groups/{granteeFolder}/credentials/borrowed → granted/{grantorFolder}/
```
Relative symlink — works inside container mount. Agent always reads `/workspace/group/credentials/borrowed/*.jsonl`.

#### Write Atomicity

Manifest writes use write-to-temp + `rename()` in the same directory. Any concurrent `cp` always reads a complete file.

#### Triggers

1. **`writeKeysFile()`** — after writing keys, regenerate the manifest for that `(scope, providerId)` by scanning the keys file for top-level credential IDs. Then start async distribution to all grantees listed in the scope owner's `credentialGrantees`.

2. **`resolver.delete()`** — delete the source manifest, then async-delete the corresponding file from all grantees.

3. **`/creds share <target>`** — after adding grantee, async-distribute ALL existing manifests from this grantor to the new grantee.

4. **`/creds revoke <target>`** — after removing grantee, `rm -rf groups/{target}/credentials/granted/{grantorFolder}/`. If the `borrowed` symlink pointed there, remove it too.

5. **`/creds borrow <source>`** — create (or update) the `borrowed` symlink: `ln -sfn granted/{sourceFolder}/ groups/{granteeFolder}/credentials/borrowed`.

6. **`/creds stop-borrowing`** — remove the `borrowed` symlink. Manifests stay in `granted/` for next time.

#### Async Distribution

After writing/deleting a manifest, a non-awaited async procedure:
1. Resolves the grantor group from the scope
2. Reads `credentialGrantees` from the grantor's config
3. For each grantee: `mkdir -p` target dir, `cp` manifest (or `rm` on deletion)
4. Distribution is unilateral — copies to all listed grantees even if borrower hasn't set `credentialSource` yet

#### Agent Discovery

Agent reads the stable path:
```
/workspace/group/credentials/borrowed/*.jsonl  → granted providers from active source
```

---

## Cleanup

### 12. `src/auth/reauth.ts` — Remove default scope warning (line 83-89)

Remove the `targetsDefault` check that warns about modifying shared credentials. Borrowed scopes are always read-only; auth flows always write to the group's own scope.

### 13. `.env.example` — Update `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` comment to reflect new behavior

### 14. Update all test files

| Test File | Changes |
|-----------|---------|
| `src/auth/provision.test.ts` | Update `createAccessCheck` tests for `credentialSource`, rename `importEnvToDefault` tests |
| `src/auth/token-substitute.test.ts` | Update sharedOp tests (line 822) to use `credentialSource` |
| `src/auth/reauth.test.ts` | Remove `DEFAULT_CREDENTIAL_SCOPE` tests (lines 192-205) |
| `src/auth/providers/claude.test.ts` | Remove `DEFAULT_CREDENTIAL_SCOPE` import if used |

---

## Files Modified (Summary)

| File | Action |
|------|--------|
| `src/types.ts` | Replace `useDefaultCredentials` with `credentialSource` + `credentialGrantees` |
| `src/auth/oauth-types.ts` | Remove `DEFAULT_CREDENTIAL_SCOPE` constant |
| `src/config.ts` | Keep `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` (repurposed for auto grant+borrow from main) |
| `src/auth/token-substitute.ts` | Rewrite `resolveCredentialScopeInternal`, remove default scope refs |
| `src/auth/provision.ts` | Rewrite `createAccessCheck`, rename `importEnvToDefault` |
| `src/auth/init.ts` | Wire migration + new import, remove re-export |
| `src/index.ts` | Remove default credential policy application |
| `src/auth/reauth.ts` | Remove `targetsDefault` warning |
| `src/commands/creds-commands.ts` | **New** — `/creds` command family |
| `src/auth/manifest.ts` | **New** — manifest write (atomic), async distribution (`cp`), cleanup on delete/revoke |
| `.env.example` | Update comment for repurposed env var |
| Test files (4) | Update to match new API |

---

## Implementation Order

1. `src/types.ts` — type change (will cause compile errors that guide remaining work)
2. `src/auth/oauth-types.ts` — remove constant
3. `src/config.ts` — repurpose env var
4. `src/auth/provision.ts` — access check + import rename
5. `src/auth/token-substitute.ts` — scope resolution, hook `writeKeysFile`/`delete` to call manifest writer
6. `src/auth/manifest.ts` — atomic manifest write + async `cp` distribution
7. `src/auth/init.ts` — wire new import
8. `src/index.ts` — remove old default policy
9. `src/auth/reauth.ts` — remove warning
10. `src/commands/creds-commands.ts` — new commands (share triggers full manifest distribution, revoke triggers cleanup)
11. Test updates
12. `.env.example` — update comment

---

## Verification

1. `npm run build` — must compile cleanly with no type errors
2. `npm test` — all existing tests pass (after updates)
3. **Scope resolution test**: Group with `credentialSource: 'groupA'` resolves to groupA's scope when own scope is empty. Falls back to own scope when it has keys.
4. **Access check test (bilateral)**: Group can access its own scope. Group can access source scope when BOTH `credentialSource` matches AND grantor's `credentialGrantees` includes it. Group with only `credentialSource` set (no grant) is denied. Group listed in grantees but without `credentialSource` set is denied.
5. **Command test**: `/creds share` and `/creds borrow` correctly update `container_config` in DB and invalidate stale substitutes.
6. **End-to-end**: Start the system, register two groups, share credentials from one to another, verify the borrowing group's container gets substitute tokens that resolve to the source group's real credentials.
