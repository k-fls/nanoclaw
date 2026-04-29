---
name: add-telegram-v2
description: Add Telegram channel integration to NanoClaw v2 via Chat SDK.
---

# Add Telegram Channel (v2)

This skill adds Telegram support to NanoClaw v2 using the Chat SDK bridge.

## Phase 1: Pre-flight

Check if `src/channels/telegram-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/telegram
```

### Enable the channel

Uncomment the Telegram import in `src/channels/index.ts`:

```typescript
import './telegram-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create Telegram Bot (if needed)

> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow the prompts:
>    - Bot name: Something friendly (e.g., "NanoClaw Assistant")
>    - Bot username: Must end with "bot" (e.g., "nanoclaw_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### Disable Group Privacy (for group chats)

> **Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:
>
> 1. Open `@BotFather` > `/mybots` > select your bot
> 2. **Bot Settings** > **Group Privacy** > **Turn off**

### Configure environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> Send a message to your bot in Telegram (search for its username).
> For groups: add the bot to a group and send a message.
> The bot should respond within a few seconds.

## Removal

1. Comment out `import './telegram-v2.js'` in `src/channels/index.ts`
2. Remove `TELEGRAM_BOT_TOKEN` from `.env`
3. `npm uninstall @chat-adapter/telegram`
4. Rebuild and restart
