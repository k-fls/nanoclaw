---
name: Persist TokenSubstituteEngine mappings
description: Design decision to persist substitute↔handle mappings per scope so they survive host restarts
type: project
---

TokenSubstituteEngine.scopes (in-memory Map of substitute → {handle, providerId, scopeAttrs}) must be persisted to disk per scope.

**Why:** Tools inside agent containers may store OAuth tokens on their own filesystem (e.g. ~/.config/gh/hosts.yml). Those tokens are substitutes. If the host restarts, the in-memory mappings are lost, new substitutes are generated for Claude, but the tool's stored substitutes become unresolvable. The tool gets 401s with no way to recover.

**How to apply:** Serialize the mappings to a file per group/scope (e.g. alongside the credential store). No encryption needed — the files contain only substitutes and opaque handles (tok_0, tok_1), no real tokens. Real tokens stay in the encrypted credential store, accessed via the handle. Reload in the TokenSubstituteEngine constructor on startup.
