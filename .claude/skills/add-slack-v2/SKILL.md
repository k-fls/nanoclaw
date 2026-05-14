---
name: add-slack-v2
description: Add Slack channel integration to NanoClaw v2 via Chat SDK.
---

# Add Slack Channel (v2)

This skill adds Slack support to NanoClaw v2 using the Chat SDK bridge.

## Phase 1: Pre-flight

Check if `src/channels/slack-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/slack
```

### Enable the channel

Uncomment the Slack import in `src/channels/index.ts`:

```typescript
import './slack-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack app:

> 1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
> 2. Name it (e.g., "NanoClaw") and select your workspace
> 3. Go to **OAuth & Permissions** and add Bot Token Scopes:
>    - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`
> 4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`)
> 5. Go to **Basic Information** and copy the **Signing Secret**
> 6. Go to **Event Subscriptions**, enable events, and subscribe to:
>    - `message.channels`, `message.groups`, `message.im`, `app_mention`
> 7. Set the Request URL to your webhook endpoint (e.g., `https://your-domain/webhook/slack`)

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Add the bot to a Slack channel, then send a message or @mention the bot.
> The bot should respond within a few seconds.

## Removal

1. Comment out `import './slack-v2.js'` in `src/channels/index.ts`
2. Remove `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` from `.env`
3. `npm uninstall @chat-adapter/slack`
4. Rebuild and restart
