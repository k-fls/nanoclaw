---
name: add-github-v2
description: Add GitHub channel integration to NanoClaw v2 via Chat SDK. PR comment threads as conversations.
---

# Add GitHub Channel (v2)

This skill adds GitHub support to NanoClaw v2 using the Chat SDK bridge. The agent can participate in PR comment threads.

## Phase 1: Pre-flight

Check if `src/channels/github-v2.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Phase 3.

## Phase 2: Apply Code Changes

### Install the adapter package

```bash
npm install @chat-adapter/github
```

### Enable the channel

Uncomment the GitHub import in `src/channels/index.ts`:

```typescript
import './github-v2.js';
```

### Build

```bash
npm run build
```

## Phase 3: Setup

### Create GitHub credentials

> 1. Go to [GitHub Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
> 2. Create a **Fine-grained token** with:
>    - Repository access: select the repos you want the bot to monitor
>    - Permissions: **Pull requests** (Read & Write), **Issues** (Read & Write)
> 3. Copy the token
> 4. Set up a webhook on your repo(s):
>    - Go to **Settings** > **Webhooks** > **Add webhook**
>    - Payload URL: `https://your-domain/webhook/github`
>    - Content type: `application/json`
>    - Secret: generate a random string
>    - Events: select **Issue comments**, **Pull request review comments**

### Configure environment

Add to `.env`:

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```

## Phase 4: Verify

> @mention the bot in a PR comment or issue comment. The bot should respond within a few seconds.

## Removal

1. Comment out `import './github-v2.js'` in `src/channels/index.ts`
2. Remove `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` from `.env`
3. `npm uninstall @chat-adapter/github`
4. Rebuild and restart
