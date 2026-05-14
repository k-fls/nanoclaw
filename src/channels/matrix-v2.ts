/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile(['MATRIX_BASE_URL', 'MATRIX_ACCESS_TOKEN', 'MATRIX_USER_ID', 'MATRIX_BOT_USERNAME']);
    if (!env.MATRIX_BASE_URL) return null;
    // Matrix adapter reads from process.env directly
    process.env.MATRIX_BASE_URL = env.MATRIX_BASE_URL;
    if (env.MATRIX_ACCESS_TOKEN) process.env.MATRIX_ACCESS_TOKEN = env.MATRIX_ACCESS_TOKEN;
    if (env.MATRIX_USER_ID) process.env.MATRIX_USER_ID = env.MATRIX_USER_ID;
    if (env.MATRIX_BOT_USERNAME) process.env.MATRIX_BOT_USERNAME = env.MATRIX_BOT_USERNAME;
    const matrixAdapter = createMatrixAdapter();
    return createChatSdkBridge({ adapter: matrixAdapter, concurrency: 'concurrent' });
  },
});
