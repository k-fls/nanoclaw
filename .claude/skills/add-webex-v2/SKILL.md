---
name: add-webex-v2
description: Add Webex channel integration to NanoClaw v2 via Chat SDK.
---

# Add Webex Channel (v2)

This skill adds Cisco Webex support to NanoClaw v2 using the Chat SDK bridge.

## Phase 1: Pre-flight

Check if `src/channels/webex-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @bitbasti/chat-adapter-webex
```

### Enable the channel

Uncomment the Webex import in `src/channels/index.ts`:

```typescript
import './webex-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Webex Bot

> 1. Go to [developer.webex.com](https://developer.webex.com/my-apps/new/bot)
> 2. Create a new bot and copy the **Bot Access Token**
> 3. Set up a webhook:
>    - Use the Webex API to create a webhook pointing to `https://your-domain/webhook/webex`
>    - Or use the Webex Developer Portal
>    - Set a webhook secret for signature verification

### Configure environment

Add to `.env`:

```bash
WEBEX_BOT_TOKEN=your-bot-token
WEBEX_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Add the bot to a Webex space or send it a direct message. The bot should respond within a few seconds.

## Removal

1. Comment out `import './webex-v2.js'` in `src/channels/index.ts`
2. Remove `WEBEX_BOT_TOKEN` and `WEBEX_WEBHOOK_SECRET` from `.env`
3. `npm uninstall @bitbasti/chat-adapter-webex`
4. Rebuild and restart
