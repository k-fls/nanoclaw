import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AsyncMutex } from './async-mutex.js';
import {
  InteractionQueue,
  type InteractionEntry,
  type ReplyFn,
} from './queue.js';
import { InteractionStatusRegistry } from './status.js';
import {
  consumeInteractions,
  processInteraction,
} from './consumer.js';
import type { ChatIO } from './types.js';
import { setInteractionPrefix } from './types.js';

function mockChat(): ChatIO & { sent: string[]; replies: string[] } {
  const chat = {
    sent: [] as string[],
    replies: [] as string[],
    async send(text: string) {
      chat.sent.push(text);
    },
    async sendRaw(text: string) {
      chat.sent.push(text);
    },
    async receive(_timeoutMs?: number): Promise<string | null> {
      return chat.replies.shift() ?? null;
    },
    hideMessage: vi.fn(),
    advanceCursor: vi.fn(),
  };
  return chat;
}

function entry(
  sourceId: string,
  replyFn?: ReplyFn | null,
): InteractionEntry {
  return {
    interactionId: `${sourceId}:12345`,
    eventType: 'notification',
    sourceId,
    eventParam: '',
    eventUrl: `https://example.com/flow?source=${sourceId}`,
    replyFn:
      replyFn === undefined ? vi.fn(async () => ({ done: true })) : replyFn,
  };
}

beforeEach(() => {
  setInteractionPrefix('🔑🤖 ');
});

describe('processInteraction', () => {
  it('presents event and delivers user reply', async () => {
    const chat = mockChat();
    chat.replies.push('AUTH_CODE_123');
    const replyFn = vi.fn(async () => ({ done: true }));
    const reg = new InteractionStatusRegistry();
    const e = entry('github', replyFn);

    await processInteraction(e, null, chat, reg);

    expect(chat.sent[0]).toContain('github');
    expect(chat.sent[0]).toContain(
      'https://example.com/flow?source=github',
    );
    expect(chat.sent[0]).toContain('Reply when ready');
    expect(replyFn).toHaveBeenCalledWith('AUTH_CODE_123');
    expect(reg.currentState('github:12345')).toBe('completed');
  });

  it('notification-only: sends single message (no replyFn)', async () => {
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const e = entry('github', null);

    await processInteraction(e, null, chat, reg);

    expect(reg.currentState('github:12345')).toBe('completed');
    expect(chat.sent.length).toBe(1);
    expect(chat.sent[0]).toContain('github');
  });

  it('uses the global interaction prefix', async () => {
    setInteractionPrefix('>> ');
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const e = entry('ssh-host', null);

    await processInteraction(e, null, chat, reg);

    expect(chat.sent[0]).toMatch(/^>> /);
  });

  it('handles user cancellation', async () => {
    const chat = mockChat();
    chat.replies.push('cancel');
    const replyFn = vi.fn(async () => ({ done: true }));
    const reg = new InteractionStatusRegistry();
    const e = entry('github', replyFn);

    await processInteraction(e, null, chat, reg);

    expect(replyFn).not.toHaveBeenCalled();
    expect(reg.currentState('github:12345')).toBe('failed');
  });

  it('loops on not-done reply then completes', async () => {
    const chat = mockChat();
    chat.replies.push('CODE1', 'CODE2');
    let callCount = 0;
    const replyFn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) return { done: false, response: 'Try again' };
      return { done: true };
    });
    const reg = new InteractionStatusRegistry();
    const e = entry('github', replyFn);

    await processInteraction(e, null, chat, reg);

    expect(replyFn).toHaveBeenCalledTimes(2);
    expect(reg.currentState('github:12345')).toBe('completed');
    expect(chat.sent.some((s) => s.includes('Try again'))).toBe(true);
  });

  it('handles receive timeout (null reply)', async () => {
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const e = entry('github');

    await processInteraction(e, null, chat, reg);

    expect(reg.currentState('github:12345')).toBe('failed');
  });

  it('acquires and releases chatLock when provided', async () => {
    const mutex = new AsyncMutex();
    const chat = mockChat();
    chat.replies.push('CODE');
    const reg = new InteractionStatusRegistry();
    const e = entry('github');

    await processInteraction(e, mutex, chat, reg);

    expect(mutex.locked).toBe(false);
  });

  it('releases chatLock even on error', async () => {
    const { muteLogger, restoreLogger } = await import('../test-helpers.js');
    const spies = muteLogger();
    try {
      const mutex = new AsyncMutex();
      const chat = mockChat();
      chat.replies.push('CODE');
      const replyFn = vi.fn(async () => {
        throw new Error('boom');
      });
      const reg = new InteractionStatusRegistry();
      const e = entry('github', replyFn);

      await processInteraction(e, mutex, chat, reg);

      expect(mutex.locked).toBe(false);
      expect(reg.currentState('github:12345')).toBe('failed');
    } finally {
      restoreLogger(spies);
    }
  });
});

describe('consumeInteractions', () => {
  it('processes entries in FIFO order then exits on abort', async () => {
    const q = new InteractionQueue();
    const mutex = new AsyncMutex();
    const chat = mockChat();
    chat.replies.push('CODE1', 'CODE2');
    const reg = new InteractionStatusRegistry();
    const abort = new AbortController();

    const fn1 = vi.fn(async () => ({ done: true }));
    const fn2 = vi.fn(async () => ({ done: true }));
    q.push(entry('github', fn1), 'test');
    q.push(entry('google', fn2), 'test');

    const consumerDone = consumeInteractions(
      q,
      mutex,
      chat,
      reg,
      abort.signal,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fn1).toHaveBeenCalledWith('CODE1');
    expect(fn2).toHaveBeenCalledWith('CODE2');

    abort.abort();
    await consumerDone;
  });

  it('exits cleanly on abort while waiting for entry', async () => {
    const q = new InteractionQueue();
    const mutex = new AsyncMutex();
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const abort = new AbortController();

    const consumerDone = consumeInteractions(
      q,
      mutex,
      chat,
      reg,
      abort.signal,
    );

    await new Promise((r) => setTimeout(r, 10));

    abort.abort();
    await consumerDone;
    expect(mutex.locked).toBe(false);
  });
});
