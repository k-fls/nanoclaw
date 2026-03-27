# Credential Scoping

Scope resolution determines which credential store a group reads from and writes to for each operation.

## Resolve Cases

Three cases based on group type and default connection:

1. **Non-main + default** — `useDefaultCredentials` is true but `isMain` is false. Falls back to default credentials per-provider when own scope has none.
2. **Main + default** — `isMain` is true. Manages the `default` scope directly. Default is literally main's scope.
3. **Own scope** — group uses only its own credentials (`{group}` scope). Either `useDefaultCredentials` is false, or the group has its own credentials for all providers.

## Scope Resolution Table

`{group}` = group's own folder name. Resolution is **per-provider** for case 1.

| Operation | 1. non-main + default | 2. main + default | 3. own scope |
|---|---|---|---|
| a. Read/use | per-provider: `{group}` if provider present, else `default` | `default` | `{group}` |
| b. Auto-refresh | per-provider: whichever scope was resolved for read | `default` | `{group}` |
| c. Add/update manually | `{group}` | `default` | `{group}` |
| d. Remove/block | `{group}` only — never deletes from `default`; may need to block a specific provider from falling back to `default` | `default` | `{group}` |
| e. Provision (write session files) | `{group}` session dir (always own, regardless of credential source) | `{group}` session dir | `{group}` session dir |

### Notes

- **Case 1, per-provider resolution**: Each provider is resolved independently. A group may use its own Claude credentials but fall back to default for another provider. If a group adds its own credentials for a provider (operation c), subsequent reads resolve to `{group}` for that provider — the group effectively disconnects from default for that provider.
- **Case 1, remove/block**: A non-main group cannot delete credentials from the `default` scope. To stop using a default provider, the group would block fallback for that specific provider (mechanism TBC).
- **Case 2**: Main exists to manage the default scope. All credential operations target `default` directly.
- **Provision (e)**: Always writes to the group's own session directory (`data/sessions/{group}/.claude/`), never to the source scope. Provisioning reads from the resolved scope and writes substitute tokens + config files to the group's own dir for container consumption.

## Substitute Mapping

`SubstituteMapping` gains a `sourceScope` field to track cross-scope credential references.

### Storage rules

- **Own credentials**: `sourceScope` is omitted (not stored). Absence means "credentials belong to this group's own scope."
- **Borrowed credentials**: `sourceScope` is set to the credential source (e.g. `'default'`). Presence means "credentials come from a different scope."

### Access control callback

The token engine takes a runtime callback at initialization:

```typescript
type ScopeAccessCheck = (group: RegisteredGroup, sourceScope: string) => boolean;
```

This callback confirms that a group is still allowed to access credentials from `sourceScope`. It is checked:

- **On read** (`resolveSubstitute`): if the check fails, the substitute is deleted and resolution returns null. The container gets a normal auth error.
- **On refresh**: if the check fails, the refreshed token is stored in `{group}` scope instead (promoting to own credentials), and the mapping's `sourceScope` is cleared.

### Update operations

Both take `RegisteredGroup` and resolve scopes internally:

- **`refreshCredential(group, providerId, role, newToken)`** — reads `sourceScope` from the mapping. If present and access check passes, writes to `sourceScope`. If access check fails, writes to `group.folder` instead and clears `sourceScope` on the mapping.
- **`addOrUpdateCredential(group, providerId, role, newToken)`** — always writes to `group.folder`. If the same provider has existing borrowed substitutes (mappings with `sourceScope` set), they are removed — the group is disconnecting from the source for this provider. The new mapping has no `sourceScope` (owned).

### Ownership takeover

When `addOrUpdateCredential` is called for a provider that currently has borrowed substitutes:

1. All borrowed substitutes for that provider in this group are removed (engine map + persisted refs).
2. The new credential is stored in `group.folder`.
3. New substitutes are generated with no `sourceScope`.

This requires the engine to efficiently find all substitutes for a given (group, provider) pair. The current flat `Map<substitute, mapping>` per scope does not support this well. The engine's internal structure should be reorganized to provide **per-provider grouping** within each scope:

```
scopes: Map<groupScope, Map<providerId, ProviderSubstitutes>>

ProviderSubstitutes {
  sourceScope?: string          // undefined = own, present = borrowed
  substitutes: Map<substitute, { role, scopeAttrs }>
}
```

This gives O(1) access to all substitutes for a (group, provider) pair, making ownership takeover, revocation, and access checks efficient without scanning the full scope map.

### Revocation on read

When `resolveSubstitute` encounters a mapping with `sourceScope` set and the access check fails:

1. The substitute is removed from the engine's scope map.
2. The persisted ref is deleted.
3. Resolution returns null — the container sees a standard auth error (401/403), which may trigger reauth.
