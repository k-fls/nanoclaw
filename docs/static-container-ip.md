# Proposal: Static Container IP via Dedicated Docker Network

## Problem

Container IPs are currently discovered by calling `docker inspect` immediately after `spawn()`. This is inherently racy — Docker may not have assigned the bridge IP yet, causing `getContainerIP()` to return `null`. When this happens, the credential proxy rejects all requests from that container because it can't map the source IP to a group scope.

The failure is silent: the container starts, the agent runs, but every API call fails with "unknown container IP".

## Current Flow

```
spawn(docker run ...)
  │
  ├── getContainerIP(name)          ← docker inspect, may return null
  │     └── race: IP not assigned yet
  │
  ├── registerContainerIP(ip, scope) ← skipped if null
  │
  └── container makes API calls
        └── proxy rejects: unknown source IP
```

## Proposed Solution

Create a dedicated Docker bridge network with a known subnet. Allocate a static IP before spawning the container and pass it via `--network nanoclaw --ip <addr>`. The IP is deterministic — no inspection needed.

### Network Creation (once, at startup)

```bash
docker network create \
  --subnet 172.29.0.0/16 \
  -o com.docker.network.bridge.enable_icc=false \
  nanoclaw
```

- **Fixed subnet** (`172.29.0.0/16`): gives 64K addresses, far more than needed.
- **`enable_icc=false`**: drops inter-container traffic at the iptables level. Containers can only reach the host gateway and external networks — not each other.

### Container Launch

```
allocateContainerIP()  →  "172.29.0.2"
  │
  ├── registerContainerIP("172.29.0.2", scope)   ← before spawn
  │
  ├── spawn(docker run --network nanoclaw --ip 172.29.0.2 ...)
  │
  └── container makes API calls
        └── proxy matches source IP → correct scope ✓
```

On container exit (close/error):
```
releaseContainerIP("172.29.0.2")
unregisterContainerIP("172.29.0.2")
```

### IP Allocator

Simple in-memory pool. Starts at `172.29.0.2` (skip `.0` network, `.1` gateway). Allocated IPs are tracked in a `Set<string>` and released on container exit.

No persistence needed — containers are `--rm` and the pool resets on process restart. Orphan cleanup (`cleanupOrphans()`) already kills stale containers at startup.

## Changes

| File | Change |
|------|--------|
| `src/container-runtime.ts` | Add `ensureNetwork()`, `allocateContainerIP()`, `releaseContainerIP()`, `networkArgs()` |
| `src/container-runtime.ts` | Call `ensureNetwork()` from `ensureContainerRuntimeRunning()` |
| `src/container-runner.ts` | Remove `getContainerIP()` (`docker inspect` helper) |
| `src/container-runner.ts` | Allocate IP before spawn, pass via `networkArgs()` in `buildContainerArgs()` |
| `src/container-runner.ts` | Release IP on container close/error |
| `src/auth/e2e-harness.ts` | Same pattern: allocate before spawn, release on close |
| `scripts/run-agent-container.sh` | Replace `docker inspect` loop with `--network nanoclaw --ip` |
| `scripts/test-transparent-proxy.ts` | Replace inspect-retry loop with static IP |
| `src/types.ts` | Add `reservedIpSuffix?: string` to `ContainerConfig` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `reserve_ip` and `release_ip` tools |

## Security Comparison

| Property | Current (default bridge) | Proposed (dedicated network) |
|----------|------------------------|------------------------------|
| Inter-container traffic | Allowed (ICC enabled by default) | **Blocked** (`enable_icc=false`) |
| Container-to-host | Via `host.docker.internal` | Same — `--add-host` still works on user-defined networks |
| IP predictability | Random, discovered after spawn | Static, assigned before spawn |
| DNS isolation | Shared default bridge DNS | Scoped to `nanoclaw` network only |
| Capability/privilege model | Unchanged | Unchanged |

The dedicated network is **strictly more isolated** than the current default bridge.

## IP Reservations

Agents can reserve a fixed IP for their group so it survives container restarts. Reservations are stored in the existing `container_config` JSON column on `registered_groups` — no new table needed.

### Storage

The `ContainerConfig` interface (in `src/types.ts`) gains one field:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  useDefaultCredentials?: boolean;
  reservedIpSuffix?: string; // last two octets, e.g. "0.2", "1.15"
}
```

Stored in the existing `container_config` TEXT column as JSON:
```json
{ "reservedIpSuffix": "0.2", "timeout": 600000 }
```

Only the last two octets are stored — the subnet prefix is applied at allocation time, so reservations remain valid if the network subnet changes.

### Allocation Flow

```
allocateContainerIP(group)
  │
  ├── group.containerConfig?.reservedIpSuffix exists?
  │     ├── YES → reconstruct full IP from prefix + suffix
  │     │         ├── not in active set? → use it ✓
  │     │         └── conflict (stale) → log warning, allocate free
  │     │
  │     └── NO → pick next free from pool (skip all reserved suffixes)
```

The allocator loads all `reservedIpSuffix` values from registered groups at startup to avoid handing out a reserved IP to a dynamic group.

### Agent Tools (IPC/MCP)

| Command | Auth | Description |
|---------|------|-------------|
| `reserve_ip` | Any agent (own group) or main-group (any group) | Persist current container IP as this group's fixed address |
| `release_ip` | Any agent (own group) or main-group (any group) | Drop reservation, revert to dynamic allocation |

**`reserve_ip`** (from container):
- Reads the container's current allocated IP (passed via env at spawn)
- Extracts suffix (last two octets)
- Updates `container_config` JSON: sets `reservedIpSuffix`
- Uniqueness enforced at application level (scan all groups for conflicting suffix before writing)
- Returns the reserved address

**`reserve_ip { group: "other-group" }`** (from main container):
- Looks up target group's active IP from in-memory pool
- Same update logic
- Requires main-group scope

**`release_ip`** / **`release_ip { group: "other-group" }`**:
- Removes `reservedIpSuffix` from `container_config` JSON
- Next spawn gets a dynamic IP

## Edge Cases

- **Network already exists** (e.g. unclean shutdown): `ensureNetwork()` is idempotent — inspects first, creates only if missing.
- **Concurrent creation race**: if two processes try to create simultaneously, the second catches the error and verifies the network exists.
- **IP pool exhaustion**: throws immediately rather than silently failing. With 65k addresses and typical concurrency of 1-5 containers, this is not a practical concern.
- **Docker restart**: Docker preserves user-defined networks across restarts. If removed manually, `ensureNetwork()` recreates it.
- **`hostGatewayArgs()`**: still needed on Linux — user-defined networks don't auto-resolve `host.docker.internal` outside Docker Desktop.
