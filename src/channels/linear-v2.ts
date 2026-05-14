/**
 * Linear channel adapter (v2) — uses Chat SDK bridge.
 * Issue comment threads as conversations.
 * Self-registers on import.
 */
import { createLinearAdapter } from '@chat-adapter/linear';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('linear', {
  factory: () => {
    const env = readEnvFile(['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET']);
    if (!env.LINEAR_API_KEY) return null;
    const linearAdapter = createLinearAdapter({
      apiKey: env.LINEAR_API_KEY,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET,
    });
    return createChatSdkBridge({ adapter: linearAdapter, concurrency: 'queue' });
  },
});
