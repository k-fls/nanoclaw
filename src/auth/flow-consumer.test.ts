import { describe, it, expect, vi } from 'vitest';

import { AsyncMutex } from './async-mutex.js';
import { FlowQueue, type FlowEntry, type ReplyFn } from './flow-queue.js';
import { FlowStatusRegistry } from './flow-status.js';
import { consumeFlows, processFlow } from './flow-consumer.js';
import type { ChatIO } from './types.js';

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

function entry(providerId: string, replyFn?: ReplyFn | null): FlowEntry {
  return {
    flowId: `${providerId}:12345`,
    eventType: 'oauth-start',
    providerId,
    eventParam: '',
    eventUrl: `https://example.com/auth?provider=${providerId}`,
    replyFn:
      replyFn === undefined ? vi.fn(async () => ({ done: true })) : replyFn,
  };
}

describe('processFlow', () => {
  it('presents event and delivers user reply', async () => {
    const chat = mockChat();
    chat.replies.push('AUTH_CODE_123');
    const replyFn = vi.fn(async () => ({ done: true }));
    const reg = new FlowStatusRegistry();
    const e = entry('github', replyFn);

    await processFlow(e, null, chat, reg);

    expect(chat.sent[0]).toContain('github');
    expect(chat.sent[0]).toContain('https://example.com/auth?provider=github');
    expect(chat.sent[0]).toContain('Reply when ready');
    expect(replyFn).toHaveBeenCalledWith('AUTH_CODE_123');
    expect(reg.currentState('github:12345')).toBe('completed');
  });

  it('device-code: sends bare code then prefixed instruction', async () => {
    const chat = mockChat();
    const reg = new FlowStatusRegistry();
    const e: FlowEntry = {
      flowId: 'github:device:123',
      eventType: 'device-code',
      providerId: 'github',
      eventParam: 'ABCD-1234',
      eventUrl: 'https://github.com/login/device',
      replyFn: null,
    };

    await processFlow(e, null, chat, reg);

    // First message: bare code (via sendRaw)
    expect(chat.sent[0]).toBe('ABCD-1234');
    // Second message: instruction with URL (via send, has prefix)
    expect(chat.sent[1]).toContain('🔑🤖');
    expect(chat.sent[1]).toContain('https://github.com/login/device');
    expect(chat.sent[1]).toContain('Copy the code above');
    expect(reg.currentState('github:device:123')).toBe('completed');
  });

  it('handles user cancellation', async () => {
    const chat = mockChat();
    chat.replies.push('cancel');
    const replyFn = vi.fn(async () => ({ done: true }));
    const reg = new FlowStatusRegistry();
    const e = entry('github', replyFn);

    await processFlow(e, null, chat, reg);

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
    const reg = new FlowStatusRegistry();
    const e = entry('github', replyFn);

    await processFlow(e, null, chat, reg);

    expect(replyFn).toHaveBeenCalledTimes(2);
    expect(reg.currentState('github:12345')).toBe('completed');
    // Should have shown the "Try again" prompt between attempts
    expect(chat.sent.some((s) => s.includes('Try again'))).toBe(true);
  });

  it('handles null replyFn (notification-only)', async () => {
    const chat = mockChat();
    const reg = new FlowStatusRegistry();
    const e = entry('github', null);

    await processFlow(e, null, chat, reg);

    expect(reg.currentState('github:12345')).toBe('completed');
    // Single notification message, no reply requested
    expect(chat.sent.length).toBe(1);
    expect(chat.sent[0]).toContain('github');
  });

  it('handles receive timeout (null reply)', async () => {
    const chat = mockChat();
    // No replies → receive returns null
    const reg = new FlowStatusRegistry();
    const e = entry('github');

    await processFlow(e, null, chat, reg);

    expect(reg.currentState('github:12345')).toBe('failed');
  });

  it('acquires and releases chatLock when provided', async () => {
    const mutex = new AsyncMutex();
    const chat = mockChat();
    chat.replies.push('CODE');
    const reg = new FlowStatusRegistry();
    const e = entry('github');

    await processFlow(e, mutex, chat, reg);

    // Lock should be released after processing
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
      const reg = new FlowStatusRegistry();
      const e = entry('github', replyFn);

      await processFlow(e, mutex, chat, reg);

      expect(mutex.locked).toBe(false);
      expect(reg.currentState('github:12345')).toBe('failed');
    } finally {
      restoreLogger(spies);
    }
  });
});

describe('consumeFlows', () => {
  it('processes entries in FIFO order then exits on abort', async () => {
    const q = new FlowQueue();
    const mutex = new AsyncMutex();
    const chat = mockChat();
    chat.replies.push('CODE1', 'CODE2');
    const reg = new FlowStatusRegistry();
    const abort = new AbortController();

    const fn1 = vi.fn(async () => ({ done: true }));
    const fn2 = vi.fn(async () => ({ done: true }));
    q.push(entry('github', fn1), 'test');
    q.push(entry('google', fn2), 'test');

    // Start consumer — it will process both entries then block on empty queue
    const consumerDone = consumeFlows(q, mutex, chat, reg, abort.signal);

    // Wait for entries to be processed
    await new Promise((r) => setTimeout(r, 50));

    expect(fn1).toHaveBeenCalledWith('CODE1');
    expect(fn2).toHaveBeenCalledWith('CODE2');

    abort.abort();
    await consumerDone;
  });

  it('exits cleanly on abort while waiting for entry', async () => {
    const q = new FlowQueue();
    const mutex = new AsyncMutex();
    const chat = mockChat();
    const reg = new FlowStatusRegistry();
    const abort = new AbortController();

    const consumerDone = consumeFlows(q, mutex, chat, reg, abort.signal);

    // Consumer is blocked waiting for entries
    await new Promise((r) => setTimeout(r, 10));

    abort.abort();
    await consumerDone; // Should resolve without hanging
    expect(mutex.locked).toBe(false);
  });
});
