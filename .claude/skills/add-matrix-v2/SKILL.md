---
name: add-matrix-v2
description: Add Matrix channel integration to NanoClaw v2 via Chat SDK. Works with any Matrix homeserver (Element, Beeper, etc.).
---

# Add Matrix Channel (v2)

This skill adds Matrix support to NanoClaw v2 using the Chat SDK bridge. Works with any Matrix homeserver.

## Phase 1: Pre-flight

Check if `src/channels/matrix-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @beeper/chat-adapter-matrix
```

### Enable the channel

Uncomment the Matrix import in `src/channels/index.ts`:

```typescript
import './matrix-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Matrix bot account

> 1. Register a bot account on your Matrix homeserver (e.g., via Element)
> 2. Get the homeserver URL (e.g., `https://matrix.org` or your self-hosted URL)
> 3. Get an access token:
>    - In Element: **Settings** > **Help & About** > **Access Token** (advanced)
>    - Or via API: `curl -XPOST 'https://matrix.org/_matrix/client/r0/login' -d '{"type":"m.login.password","user":"botuser","password":"..."}'`
> 4. Note the bot's user ID (e.g., `@botuser:matrix.org`)

### Configure environment

Add to `.env`:

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your-access-token
MATRIX_USER_ID=@botuser:matrix.org
MATRIX_BOT_USERNAME=botuser
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Invite the bot to a Matrix room and send a message. The bot should respond within a few seconds.

## Removal

1. Comment out `import './matrix-v2.js'` in `src/channels/index.ts`
2. Remove `MATRIX_BASE_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`, `MATRIX_BOT_USERNAME` from `.env`
3. `npm uninstall @beeper/chat-adapter-matrix`
4. Rebuild and restart
