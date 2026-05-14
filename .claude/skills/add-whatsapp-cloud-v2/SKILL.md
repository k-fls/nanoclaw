---
name: add-whatsapp-cloud-v2
description: Add WhatsApp Business Cloud API channel to NanoClaw v2 via Chat SDK. Official Meta API (not Baileys).
---

# Add WhatsApp Cloud API Channel (v2)

This skill adds WhatsApp support via the official Meta WhatsApp Business Cloud API. This is different from the Baileys-based WhatsApp adapter (which uses WhatsApp Web protocol).

## Phase 1: Pre-flight

Check if `src/channels/whatsapp-cloud-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/whatsapp
```

### Enable the channel

Uncomment the WhatsApp Cloud API import in `src/channels/index.ts`:

```typescript
import './whatsapp-cloud-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create WhatsApp Business App

> 1. Go to [Meta for Developers](https://developers.facebook.com/apps/) and create an app (type: Business)
> 2. Add the **WhatsApp** product
> 3. Go to **WhatsApp** > **API Setup**:
>    - Note the **Phone Number ID** (not the phone number itself)
>    - Generate a **permanent System User access token** with `whatsapp_business_messaging` permission
> 4. Go to **WhatsApp** > **Configuration**:
>    - Set webhook URL: `https://your-domain/webhook/whatsapp`
>    - Set a **Verify Token** (any random string you choose)
>    - Subscribe to webhook fields: `messages`
> 5. Copy the **App Secret** from **Settings** > **Basic**

### Configure environment

Add to `.env`:

```bash
WHATSAPP_ACCESS_TOKEN=your-system-user-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_APP_SECRET=your-app-secret
WHATSAPP_VERIFY_TOKEN=your-verify-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Send a message to your WhatsApp Business number. The bot should respond within a few seconds.
> Note: WhatsApp Cloud API only supports 1:1 DMs, not group chats.

## Removal

1. Comment out `import './whatsapp-cloud-v2.js'` in `src/channels/index.ts`
2. Remove `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` from `.env`
3. `npm uninstall @chat-adapter/whatsapp`
4. Rebuild and restart
