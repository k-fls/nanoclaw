---
name: add-teams-v2
description: Add Microsoft Teams channel integration to NanoClaw v2 via Chat SDK.
---

# Add Microsoft Teams Channel (v2)

This skill adds Microsoft Teams support to NanoClaw v2 using the Chat SDK bridge.

## Phase 1: Pre-flight

Check if `src/channels/teams-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/teams
```

### Enable the channel

Uncomment the Teams import in `src/channels/index.ts`:

```typescript
import './teams-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Teams Bot

> 1. Go to [Azure Portal](https://portal.azure.com) > **Azure Bot** > **Create**
> 2. Fill in the bot details and create
> 3. Go to **Configuration**:
>    - Messaging endpoint: `https://your-domain/webhook/teams`
> 4. Go to **Channels** > add **Microsoft Teams**
> 5. Note the **Microsoft App ID** and **Password** (from the bot's Azure AD app registration)

### Configure environment

Add to `.env`:

```bash
TEAMS_APP_ID=your-app-id
TEAMS_APP_PASSWORD=your-app-password
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Add the bot to a Teams channel or send it a direct message. The bot should respond within a few seconds.

## Removal

1. Comment out `import './teams-v2.js'` in `src/channels/index.ts`
2. Remove `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` from `.env`
3. `npm uninstall @chat-adapter/teams`
4. Rebuild and restart
