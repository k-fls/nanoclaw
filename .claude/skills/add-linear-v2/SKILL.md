---
name: add-linear-v2
description: Add Linear channel integration to NanoClaw v2 via Chat SDK. Issue comment threads as conversations.
---

# Add Linear Channel (v2)

This skill adds Linear support to NanoClaw v2 using the Chat SDK bridge. The agent can participate in issue comment threads.

## Phase 1: Pre-flight

Check if `src/channels/linear-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/linear
```

### Enable the channel

Uncomment the Linear import in `src/channels/index.ts`:

```typescript
import './linear-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Linear credentials

> 1. Go to [Linear Settings > API](https://linear.app/settings/api)
> 2. Create a **Personal API Key** (or use an OAuth application for team-wide access)
> 3. Copy the API key
> 4. Set up a webhook:
>    - Go to **Settings** > **API** > **Webhooks** > **New webhook**
>    - URL: `https://your-domain/webhook/linear`
>    - Select events: **Comment** (created, updated)
>    - Copy the signing secret

### Configure environment

Add to `.env`:

```bash
LINEAR_API_KEY=lin_api_...
LINEAR_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> @mention the bot in a Linear issue comment. The bot should respond within a few seconds.

## Removal

1. Comment out `import './linear-v2.js'` in `src/channels/index.ts`
2. Remove `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET` from `.env`
3. `npm uninstall @chat-adapter/linear`
4. Rebuild and restart
