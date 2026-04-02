# Test Coverage Gap Plan

Based on V8 coverage analysis (62.4% stmts, 52.8% branches overall).
Gaps ranked by code-level criticality, not file names.

## Phase 1 — Security boundaries (bugs = credential/data exposure)

### 1.1 `src/mount-security.ts` — 4% stmts, 0% funcs
**New file:** `src/mount-security.test.ts`

| Function | What to test |
|----------|-------------|
| `loadMountAllowlist()` | Missing file returns null; invalid JSON returns null; valid JSON parsed + cached; default blocked patterns merged; structure validation (missing fields) |
| `validateMount()` | No allowlist → blocked; invalid containerPath (`..`, absolute, empty) → blocked; non-existent hostPath → blocked; blocked pattern match (`.ssh`, `.aws`, etc.) → blocked; path not under any root → blocked; happy path under allowed root |
| `validateMount()` readonly | Non-main + `nonMainReadOnly` → forced readonly; root without `allowReadWrite` → forced readonly; main + `allowReadWrite` root → read-write |
| `validateAdditionalMounts()` | Mix of valid/rejected mounts; containerPath defaults to basename |
| `isValidContainerPath()` | Traversal, absolute, empty, valid relative |
| `matchesBlockedPattern()` | Exact component match; substring in component; full path contains pattern |
| `expandPath()` | `~/foo` expansion; `~` alone; absolute passthrough |

**Approach:** Mock `fs.existsSync`, `fs.readFileSync`, `fs.realpathSync` via `vi.mock('fs')`.
Mock `MOUNT_ALLOWLIST_PATH` via `vi.mock('./config.js')`. Reset cached allowlist between tests
by re-importing or exposing a reset function.

### 1.2 `src/credential-proxy.ts` `validateCaller` — line 560
**Add to:** `src/credential-proxy.test.ts` (existing)

| What to test |
|-------------|
| Known container IP → returns scope |
| Unknown IP → returns null |
| IPv6-mapped IPv4 normalization (`::ffff:172.17.0.2` → `172.17.0.2`) |

**Approach:** `registerContainerIP` then call through an HTTP request from that IP,
or test `resolveScope` directly if exposed.

### 1.3 `src/auth/exec.ts` helpers — 6.25% stmts
**New file:** `src/auth/exec.test.ts`

| Function | What to test |
|----------|-------------|
| `scopeDataDir(scope, ...sub)` | Returns `{DATA_DIR}/sessions/{scope}/{sub}` |
| `scopeClaudeDir(scope, ...sub)` | Returns `{DATA_DIR}/sessions/{scope}/.claude/{sub}` |
| `authSessionDir(scope)` | Returns `{DATA_DIR}/sessions/{scope}/.claude-auth` |
| `ensureClaudeConfigStub()` | Creates file if missing; no-op if exists |

**Approach:** Mock `DATA_DIR` via `vi.mock('../config.js')`. Use real tmp dir for
`ensureClaudeConfigStub`. `execInContainer` is hard to unit test (spawns Docker) — skip for now.

## Phase 2 — Auth wiring (bugs = silent auth failures)

### 2.1 `src/auth/session-context.ts` — 0% everything
**New file:** `src/auth/session-context.test.ts`

| What to test |
|-------------|
| `createSessionContext()` returns all fields |
| flowQueue mutation → statusRegistry receives event |
| `onAuthError` with extractable request ID → records in pendingErrors |
| `onAuthError` with non-extractable body → no record |

**Approach:** Pure unit test. No mocking needed — instantiate real FlowQueue,
FlowStatusRegistry, PendingAuthErrors.

### 2.2 `src/auth/registry.ts` — 33.9% stmts
**Add to:** `src/auth/registry.test.ts` (existing)

| Function | What to test |
|----------|-------------|
| `getTokenResolver()` | Returns singleton PersistentTokenResolver |
| `getTokenEngine()` | Returns singleton; calls loadAllPersistedRefs |
| `registerProvider()` | Registers in map; registers host rules with proxy |

**Approach:** Heavy mocking — mock credential-proxy, token-substitute, store, providers/claude.

### 2.3 `src/auth/flow-status.ts` SSE — 58% stmts
**Add to:** `src/auth/flow-status.test.ts` (existing)

| Function | What to test |
|----------|-------------|
| `handleSSE()` | Writes correct headers; replays existing events; adds subscriber; removes on close |
| `handleListFlows()` | Returns JSON array of flows |
| `destroy()` | Ends all SSE connections; clears flows |

**Approach:** Use mock `ServerResponse` objects (writable streams with `writeHead`).

## Phase 3 — Data integrity (bugs = data loss, silent task failures)

### 3.1 `src/db.ts` group deserialization — 52.6% stmts
**Add to:** `src/db.test.ts` (existing)

| Function | What to test |
|----------|-------------|
| `getRegisteredGroup()` | Returns group with parsed containerConfig; invalid folder → undefined + warning |
| `getAllRegisteredGroups()` | Skips invalid folders; parses containerConfig JSON |
| `setRegisteredGroup()` | Invalid folder → throws |
| `migrateJsonState()` | Migrates router_state.json, sessions.json, registered_groups.json; skips missing files |

**Approach:** Use `_initTestDatabase()`. For migration, write temp JSON files then call init.

### 3.2 `src/task-scheduler.ts` `runTask` — 44.9% stmts
**New file is unnecessary** — existing `src/task-scheduler.test.ts` can be extended.

| What to test |
|-------------|
| Invalid group folder → pauses task, logs error |
| Group not found → logs error |
| Container success → logs run, computes next_run |
| Container error → logs error run |
| Streaming output forwarding via sendMessage |

**Approach:** Mock `container-runner.js`, `db.js`, `group-folder.js`. Inject mock deps.

### 3.3 `src/ipc.ts` message authorization — 42.9% stmts
**Add to:** `src/ipc-auth.test.ts` (existing)

| What to test |
|-------------|
| Main group can send message to any chat |
| Non-main group can send message to own chat only |
| Non-main group sending to other chat → blocked |

**Approach:** Call `processTaskIpc` with `type: 'message'`... wait, messages are handled
in `startIpcWatcher` not `processTaskIpc`. Would need to extract message auth logic
or test via filesystem. Lower priority — defer.

## Phase 4 — Provider logic (bugs = token leak, refresh failure)

### 4.1 `src/auth/providers/claude.ts` `prepareEnv` — lines 680-718
**Add to:** `src/auth/providers/claude.test.ts` (existing)

| What to test |
|-------------|
| Generates substitute access + refresh tokens |
| Writes .credentials.json with substitute tokens + real expiresAt |
| Returns env object |

**Approach:** Mock token-substitute engine, store, filesystem.

### 4.2 `src/auth/universal-oauth-handler.ts` — lines 420-582
**Add to:** `src/auth/universal-oauth-handler.test.ts` (existing)

| What to test |
|-------------|
| `createTokenExchangeHandler` — swaps substitute refresh_token in request body (JSON + form-encoded) |
| `createTokenExchangeHandler` — captures real tokens in response, returns substitutes |
| `createAuthorizeStubHandler` — intercepts auth URL, returns stub response |
| `createAuthorizeStubHandler` — no session → passthrough |

**Approach:** Mock HTTP request/response objects, token engine.

## Execution order

```
Phase 1.1  mount-security.test.ts        (new)     ~30 tests
Phase 2.1  session-context.test.ts        (new)     ~5 tests
Phase 1.3  auth/exec.test.ts              (new)     ~8 tests
Phase 2.3  flow-status.test.ts            (extend)  ~8 tests
Phase 3.1  db.test.ts                     (extend)  ~10 tests
Phase 1.2  credential-proxy.test.ts       (extend)  ~3 tests
Phase 2.2  auth/registry.test.ts          (extend)  ~5 tests
Phase 3.2  task-scheduler.test.ts         (extend)  ~6 tests
Phase 4.1  providers/claude.test.ts       (extend)  ~4 tests
Phase 4.2  universal-oauth-handler.test.ts(extend)  ~6 tests
```

Estimated: ~85 new tests. Target: raise overall to ~75% stmts, ~65% branches.
