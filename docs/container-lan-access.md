# Proposal: Per-Container LAN Access via Environment Providers

## Problem

Containers on the `nanoclaw` bridge can reach the internet and the credential proxy, but not the host's LAN. Some groups need LAN access (home automation, NAS APIs, local services). The mechanism for providing LAN access is environment-specific — Synology/OVS uses veth+VLAN, other hosts may use iptables MASQUERADE or macvlan, cloud VMs may not need it at all.

## Design: LAN Provider Interface

A pluggable provider pattern keeps environment-specific networking code out of the core. The container runner calls a thin interface; the active provider does the plumbing.

### Interface

```typescript
// src/lan/provider.ts

export interface LanProvider {
  /** Human-readable name for logs. */
  readonly name: string;

  /** One-time setup (create OVS ports, iptables rules, etc). Called at startup. */
  init(): Promise<void>;

  /** Attach a LAN interface to a running container. Returns the LAN IP assigned. */
  attach(containerName: string, groupFolder: string): Promise<string>;

  /** Detach and clean up when container exits. */
  detach(containerName: string, groupFolder: string): Promise<void>;

  /** Full cleanup on shutdown. */
  destroy(): Promise<void>;
}
```

### Provider Selection

Driven by environment variable — no provider loaded by default:

```
LAN_PROVIDER=ovs-vlan    # Synology/OVS
LAN_PROVIDER=masquerade  # Linux with iptables
# unset = no LAN access available
```

```typescript
// src/lan/index.ts

export function loadLanProvider(): LanProvider | null {
  switch (process.env.LAN_PROVIDER) {
    case 'ovs-vlan': return new OvsVlanProvider();
    case 'masquerade': return new MasqueradeProvider();
    default: return null;
  }
}
```

When no provider is loaded, the `lan_access` group flag is ignored and the agent tools (`enable_lan` / `disable_lan`) return an error explaining LAN access is not configured.

### Core Integration

Minimal touchpoints in `container-runner.ts`:

```typescript
// After spawn, if group has lan_access enabled and provider exists:
if (group.lanAccess && lanProvider) {
  const lanIp = await lanProvider.attach(containerName, group.folder);
  logger.info({ group: group.name, lanIp }, 'LAN interface attached');
}

// On container exit:
if (group.lanAccess && lanProvider) {
  await lanProvider.detach(containerName, group.folder);
}
```

## Provider: OVS VLAN (Synology)

For Synology DSM 6.x with VMM and Open vSwitch.

### Prerequisites

- OVS bridge exists (`ovs_bond0`)
- VLAN tag configured on OVS and switch
- `ip` at `/usr/sbin/ip`
- DHCP server on the VLAN (router)

### Configuration

```
LAN_PROVIDER=ovs-vlan
OVS_BRIDGE=ovs_bond0
OVS_VLAN_TAG=7
LAN_SUBNET=192.168.22.0/24
```

### How It Works

Uses veth pairs added directly to OVS — the same pattern VMM uses for its `tap` interfaces.

**`init()`** — verify OVS bridge exists:
```bash
ovs-vsctl br-exists ovs_bond0
```

**`attach(containerName, groupFolder)`**:

```bash
# 1. Create veth pair (deterministic names from group folder)
ip link add nc_<group>_h type veth peer name nc_<group>_c

# 2. Add host end to OVS with VLAN tag
ovs-vsctl --may-exist add-port ovs_bond0 nc_<group>_h tag=7
ip link set nc_<group>_h up

# 3. Get container PID
pid=$(docker inspect -f '{{.State.Pid}}' <containerName>)

# 4. Move container end into container's network namespace
ip link set nc_<group>_c netns $pid

# 5. Configure inside container
docker exec <containerName> ip link set nc_<group>_c up
docker exec <containerName> dhclient nc_<group>_c
```

Returns the IP assigned by DHCP (read via `docker exec <container> ip -4 addr show nc_<group>_c`).

**`detach(containerName, groupFolder)`**:

```bash
# Remove OVS port — veth pair auto-destroyed
ovs-vsctl --if-exists del-port ovs_bond0 nc_<group>_h
```

**`destroy()`** — clean up any orphaned ports:
```bash
# Find all nc_*_h ports on the bridge and remove them
ovs-vsctl list-ports ovs_bond0 | grep '^nc_' | xargs -I{} ovs-vsctl del-port ovs_bond0 {}
```

### Why This Works on Synology

VMM creates `tap` interfaces and adds them to OVS with VLAN tags — exactly what we do with veth pairs. This is a proven pattern on the platform:

```
# VMM does this:
Port "tap02113222ee9d"
    tag: 7
    Interface "tap02113222ee9d"

# We do this:
Port "nc_mygroup_h"
    tag: 7
    Interface "nc_mygroup_h"
```

### Container Image Changes

Add to Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    iproute2 isc-dhcp-client \
    && rm -rf /var/lib/apt/lists/*
```

### DHCP and MAC Addresses

DHCP uses the veth's auto-generated MAC. For stable DHCP reservations on the router, assign a deterministic MAC per group:

```bash
ip link set nc_<group>_c address 02:nc:00:00:00:<index>
```

Where `<index>` is derived from a hash of the group folder. The router maps MAC to a fixed IP.

## Provider: Masquerade (Generic Linux)

For standard Linux hosts where containers just need outbound LAN access.

### Configuration

```
LAN_PROVIDER=masquerade
LAN_SUBNET=192.168.1.0/24
```

### How It Works

**`init()`**:
```bash
iptables -t nat -C POSTROUTING -s 172.29.0.0/16 -d 192.168.1.0/24 -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s 172.29.0.0/16 -d 192.168.1.0/24 -j MASQUERADE
```

**`attach()`** — no-op (rule covers all containers on the nanoclaw subnet).

**`detach()`** — no-op.

**`destroy()`**:
```bash
iptables -t nat -D POSTROUTING -s 172.29.0.0/16 -d 192.168.1.0/24 -j MASQUERADE
```

Simpler but less isolated — all LAN-enabled containers share the host's IP on the LAN.

## Group Configuration

LAN access is a per-group flag stored in the existing `container_config` JSON column on `registered_groups`:

```json
{ "lan_access": true }
```

## Agent Tools (IPC/MCP)

| Command | Auth | Description |
|---------|------|-------------|
| `enable_lan` | Own group or main-group | Enable LAN access for a group (sets flag, takes effect on next container spawn) |
| `disable_lan` | Own group or main-group | Disable LAN access for a group |

Both return an error if no LAN provider is configured.

## File Structure

```
src/lan/
  provider.ts        # LanProvider interface
  index.ts           # loadLanProvider() factory
  ovs-vlan.ts        # Synology/OVS implementation
  masquerade.ts      # Generic Linux implementation
```

No code is loaded unless `LAN_PROVIDER` is set. The `src/lan/` directory is self-contained — removing it has zero effect on core functionality.

## Cleanup and Reliability

| Scenario | Handling |
|----------|----------|
| Container exits normally | `detach()` called from `container.on('close')` |
| Container crashes | `detach()` called from `container.on('error')` |
| NanoClaw restarts | `destroy()` in `init()` cleans orphaned ports before starting fresh |
| OVS port already exists | `--may-exist` / `--if-exists` flags make operations idempotent |
| DHCP fails | `attach()` returns error, container runs without LAN (proxy still works via nanoclaw bridge) |
| `docker inspect` for PID | Reliable — PID exists as soon as container process starts, unlike IP assignment |
