/**
 * ChatIO factory — creates a ChatIO adapter that routes interactive
 * flow messages through the normal channel messaging path.
 */
import type { ChatIO } from './types.js';
import type { Channel } from '../types.js';
import { getMessagesSince, HIDE_REASON, hideMessage } from '../db.js';

export interface ChatIODeps {
  channel: Channel;
  chatJid: string;
  /** Read/write the per-group agent cursor — used by advanceCursor(). */
  getAgentTimestamp: () => string;
  setAgentTimestamp: (ts: string) => void;
  saveState: () => void;
}

/** Create a ChatIO that routes through the normal channel messaging. */
export function createChatIO(deps: ChatIODeps): ChatIO {
  const {
    channel,
    chatJid,
    getAgentTimestamp,
    setAgentTimestamp,
    saveState,
  } = deps;

  let lastReceivedTs: string | null = null;
  let lastReceivedId: string | null = null;
  return {
    async send(text: string): Promise<void> {
      await channel.sendMessage(chatJid, text);
    },
    async sendRaw(text: string): Promise<void> {
      await channel.sendMessage(chatJid, text);
    },
    async receive(timeoutMs = 120_000): Promise<string | null> {
      const start = Date.now();
      const cursor = getMessagesSince(chatJid, '');
      const lastTs =
        cursor.length > 0 ? cursor[cursor.length - 1].timestamp : '';
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2000));
        const newer = getMessagesSince(chatJid, lastTs);
        if (newer.length > 0) {
          lastReceivedTs = newer[0].timestamp;
          lastReceivedId = newer[0].id;
          return newer[0].content;
        }
      }
      return null;
    },
    hideMessage(): void {
      if (lastReceivedId) {
        hideMessage(chatJid, lastReceivedId, HIDE_REASON.FLOW);
        lastReceivedId = null;
      }
    },
    advanceCursor(): void {
      if (lastReceivedTs) {
        setAgentTimestamp(lastReceivedTs);
        saveState();
      }
    },
  };
}
