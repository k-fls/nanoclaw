---
name: add-resend-v2
description: Add Resend (email) channel integration to NanoClaw v2 via Chat SDK.
---

# Add Resend Email Channel (v2)

This skill adds email support via Resend to NanoClaw v2 using the Chat SDK bridge.

## Phase 1: Pre-flight

Check if `src/channels/resend-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @resend/chat-sdk-adapter
```

### Enable the channel

Uncomment the Resend import in `src/channels/index.ts`:

```typescript
import './resend-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Resend credentials

> 1. Go to [resend.com](https://resend.com) and create an account
> 2. Add and verify your sending domain
> 3. Go to **API Keys** and create a new key
> 4. Set up a webhook:
>    - Go to **Webhooks** > **Add webhook**
>    - URL: `https://your-domain/webhook/resend`
>    - Events: select **email.received** (for inbound email)
>    - Copy the signing secret

### Configure environment

Add to `.env`:

```bash
RESEND_API_KEY=re_...
RESEND_FROM_ADDRESS=bot@yourdomain.com
RESEND_FROM_NAME=NanoClaw
RESEND_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Send an email to the configured from address. The bot should respond via email within a few seconds.

## Removal

1. Comment out `import './resend-v2.js'` in `src/channels/index.ts`
2. Remove `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_FROM_NAME`, `RESEND_WEBHOOK_SECRET` from `.env`
3. `npm uninstall @resend/chat-sdk-adapter`
4. Rebuild and restart
