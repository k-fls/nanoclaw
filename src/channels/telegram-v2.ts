/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const telegramAdapter = createTelegramAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      mode: 'polling',
    });
    return createChatSdkBridge({ adapter: telegramAdapter, concurrency: 'concurrent' });
  },
});
