---
name: add-imessage-v2
description: Add iMessage channel integration to NanoClaw v2 via Chat SDK. Local (macOS) or remote (Photon API) mode.
---

# Add iMessage Channel (v2)

This skill adds iMessage support to NanoClaw v2 using the Chat SDK bridge. Supports local mode (macOS with Full Disk Access) and remote mode (via Photon API).

## Phase 1: Pre-flight

Check if `src/channels/imessage-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install chat-adapter-imessage
```

### Enable the channel

Uncomment the iMessage import in `src/channels/index.ts`:

```typescript
import './imessage-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Local Mode (macOS)

> **Requirements**: macOS with Full Disk Access granted to your terminal/Node.js process.
>
> 1. Go to **System Settings** > **Privacy & Security** > **Full Disk Access**
> 2. Add your terminal app (Terminal, iTerm2, etc.) or the Node.js binary
> 3. The adapter reads directly from the iMessage database on disk

### Remote Mode (Photon API)

> 1. Set up a [Photon](https://photon.im) account
> 2. Get your server URL and API key

### Configure environment

**Local mode** — add to `.env`:

```bash
IMESSAGE_ENABLED=true
IMESSAGE_LOCAL=true
```

**Remote mode** — add to `.env`:

```bash
IMESSAGE_LOCAL=false
IMESSAGE_SERVER_URL=https://your-photon-server.com
IMESSAGE_API_KEY=your-api-key
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Phase 4: Verify

> Send an iMessage to the account running NanoClaw. The bot should respond within a few seconds.

## Removal

1. Comment out `import './imessage-v2.js'` in `src/channels/index.ts`
2. Remove iMessage env vars from `.env`
3. `npm uninstall chat-adapter-imessage`
4. Rebuild and restart
