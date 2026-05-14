---
name: add-gchat-v2
description: Add Google Chat channel integration to NanoClaw v2 via Chat SDK.
---

# Add Google Chat Channel (v2)

This skill adds Google Chat support to NanoClaw v2 using the Chat SDK bridge.

## Phase 1: Pre-flight

Check if `src/channels/gchat-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/gchat
```

### Enable the channel

Uncomment the Google Chat import in `src/channels/index.ts`:

```typescript
import './gchat-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Google Chat App

> 1. Go to [Google Cloud Console](https://console.cloud.google.com)
> 2. Create or select a project
> 3. Enable the **Google Chat API**
> 4. Go to **Google Chat API** > **Configuration**:
>    - App name and description
>    - Connection settings: select **HTTP endpoint URL** and set to `https://your-domain/webhook/gchat`
> 5. Create a **Service Account**:
>    - Go to **IAM & Admin** > **Service Accounts** > **Create Service Account**
>    - Grant the Chat Bot role
>    - Create a JSON key and download it

### Configure environment

Add the service account JSON as a single-line string to `.env`:

```bash
GCHAT_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Add the bot to a Google Chat space, then send a message or @mention the bot.

## Removal

1. Comment out `import './gchat-v2.js'` in `src/channels/index.ts`
2. Remove `GCHAT_CREDENTIALS` from `.env`
3. `npm uninstall @chat-adapter/gchat`
4. Rebuild and restart
