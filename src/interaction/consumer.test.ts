import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AsyncMutex } from './async-mutex.js';
import {
  InteractionQueue,
  type InteractionEntry,
  type InteractionEventKind,
  type ReplyFn,
} from './queue.js';
import { InteractionStatusRegistry } from './status.js';
import {
  consumeInteractions,
  createHandlerContext,
  defaultHandler,
  InteractionAbortedError,
  registerInteractionHandler,
  type HandlerContext,
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
  eventType: InteractionEventKind = 'notification',
): InteractionEntry {
  return {
    interactionId: `${sourceId}:12345`,
    eventType,
    sourceId,
    eventParam: '',
    eventUrl: `https://example.com/flow?source=${sourceId}`,
    replyFn:
      replyFn === undefined ? vi.fn(async () => ({ done: true })) : replyFn,
  };
}

function handlerCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    chat: mockChat(),
    queue: new InteractionQueue(),
    statusRegistry: new InteractionStatusRegistry(),
    ...overrides,
  };
}

beforeEach(() => {
  setInteractionPrefix('🔑🤖 ');
});

// ── defaultHandler ──────────────────────────────────────────────────

describe('defaultHandler', () => {
  it('presents event and delivers user reply', async () => {
    const chat = mockChat();
    chat.replies.push('AUTH_CODE_123');
    const replyFn = vi.fn(async () => ({ done: true }));
    const reg = new InteractionStatusRegistry();
    const e = entry('github', replyFn);

    await defaultHandler(e, handlerCtx({ chat, statusRegistry: reg }));

    expect(chat.sent[0]).toContain('github');
    expect(chat.sent[0]).toContain('https://example.com/flow?source=github');
    expect(chat.sent[0]).toContain('Reply when ready');
    expect(replyFn).toHaveBeenCalledWith('AUTH_CODE_123');
    expect(reg.currentState('github:12345')).toBe('completed');
  });

  it('notification-only: sends single message (no replyFn)', async () => {
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const e = entry('github', null);

    await defaultHandler(e, handlerCtx({ chat, statusRegistry: reg }));

    expect(reg.currentState('github:12345')).toBe('completed');
    expect(chat.sent.length).toBe(1);
    expect(chat.sent[0]).toContain('github');
  });

  it('uses the global interaction prefix', async () => {
    setInteractionPrefix('>> ');
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const e = entry('ssh-host', null);

    await defaultHandler(e, handlerCtx({ chat, statusRegistry: reg }));

    expect(chat.sent[0]).toMatch(/^>> /);
  });

  it('handles user cancellation', async () => {
    const chat = mockChat();
    chat.replies.push('cancel');
    const replyFn = vi.fn(async () => ({ done: true }));
    const reg = new InteractionStatusRegistry();
    const e = entry('github', replyFn);

    await defaultHandler(e, handlerCtx({ chat, statusRegistry: reg }));

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

    await defaultHandler(e, handlerCtx({ chat, statusRegistry: reg }));

    expect(replyFn).toHaveBeenCalledTimes(2);
    expect(reg.currentState('github:12345')).toBe('completed');
    expect(chat.sent.some((s) => s.includes('Try again'))).toBe(true);
  });

  it('handles receive timeout (null reply)', async () => {
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const e = entry('github');

    await defaultHandler(e, handlerCtx({ chat, statusRegistry: reg }));

    expect(reg.currentState('github:12345')).toBe('failed');
  });
});

// ── consumeInteractions ─────────────────────────────────────────────

describe('consumeInteractions', () => {
  it('processes entries in FIFO order then exits on abort', async () => {
    const q = new InteractionQueue();
    const mutex = new AsyncMutex();
    const chat = mockChat();
    chat.replies.push('CODE1', 'CODE2');
    const reg = new InteractionStatusRegistry();
    const abort = new AbortController();
    const ctx = handlerCtx({ chat, queue: q, statusRegistry: reg });

    const fn1 = vi.fn(async () => ({ done: true }));
    const fn2 = vi.fn(async () => ({ done: true }));
    q.push(entry('github', fn1), 'test');
    q.push(entry('google', fn2), 'test');

    const consumerDone = consumeInteractions(q, mutex, ctx, abort.signal);

    await new Promise((r) => setTimeout(r, 50));

    expect(fn1).toHaveBeenCalledWith('CODE1');
    expect(fn2).toHaveBeenCalledWith('CODE2');

    abort.abort();
    await consumerDone;
  });

  it('exits cleanly on abort while waiting for entry', async () => {
    const q = new InteractionQueue();
    const mutex = new AsyncMutex();
    const reg = new InteractionStatusRegistry();
    const abort = new AbortController();
    const ctx = handlerCtx({ queue: q, statusRegistry: reg });

    const consumerDone = consumeInteractions(q, mutex, ctx, abort.signal);

    await new Promise((r) => setTimeout(r, 10));

    abort.abort();
    await consumerDone;
    expect(mutex.locked).toBe(false);
  });

  it('releases chatLock even on handler error', async () => {
    const { muteLogger, restoreLogger } = await import('../test-helpers.js');
    const spies = muteLogger();
    try {
      const q = new InteractionQueue();
      const mutex = new AsyncMutex();
      const chat = mockChat();
      const reg = new InteractionStatusRegistry();
      const abort = new AbortController();
      const ctx = handlerCtx({ chat, queue: q, statusRegistry: reg });

      // Push an entry whose replyFn throws
      const e = entry(
        'github',
        vi.fn(async () => {
          throw new Error('boom');
        }),
      );
      chat.replies.push('CODE');
      q.push(e, 'test');

      const consumerDone = consumeInteractions(q, mutex, ctx, abort.signal);

      await new Promise((r) => setTimeout(r, 50));

      // Lock should be released despite the error
      expect(mutex.locked).toBe(false);
      expect(reg.currentState('github:12345')).toBe('failed');

      abort.abort();
      await consumerDone;
    } finally {
      restoreLogger(spies);
    }
  });

  it('dispatches to registered handler for event type', async () => {
    const customHandler = vi.fn(async () => {});
    registerInteractionHandler(
      'notification' as InteractionEventKind,
      customHandler,
    );

    try {
      const q = new InteractionQueue();
      const mutex = new AsyncMutex();
      const chat = mockChat();
      const reg = new InteractionStatusRegistry();
      const abort = new AbortController();
      const ctx = handlerCtx({ chat, queue: q, statusRegistry: reg });

      q.push(entry('github', null), 'test');

      const consumerDone = consumeInteractions(q, mutex, ctx, abort.signal);

      await new Promise((r) => setTimeout(r, 50));

      expect(customHandler).toHaveBeenCalledTimes(1);
      const [handledEntry, hCtx] = customHandler.mock.calls[0] as unknown as [
        InteractionEntry,
        HandlerContext,
      ];
      expect(handledEntry.sourceId).toBe('github');
      expect(hCtx.chat).toBe(chat);
      expect(hCtx.queue).toBe(q);
      expect(hCtx.statusRegistry).toBe(reg);

      abort.abort();
      await consumerDone;
    } finally {
      // Clean up — deregister by re-registering with default
      registerInteractionHandler(
        'notification' as InteractionEventKind,
        defaultHandler,
      );
    }
  });

  it('revoked context throws InteractionAbortedError in handler', async () => {
    const q = new InteractionQueue();
    const mutex = new AsyncMutex();
    const chat = mockChat();
    const reg = new InteractionStatusRegistry();
    const abort = new AbortController();

    const { ctx, revoke } = createHandlerContext(chat, q, reg);

    // Register a handler that accesses ctx.chat after revoke
    let caughtError: unknown = null;
    registerInteractionHandler(
      'notification' as InteractionEventKind,
      async (_entry, handlerCtx) => {
        // First access works
        await handlerCtx.chat.send('step 1');
        // Simulate container stop
        revoke();
        // Next access should throw
        try {
          await handlerCtx.chat.send('step 2');
        } catch (err) {
          caughtError = err;
          throw err;
        }
      },
    );

    try {
      q.push(entry('github', null), 'test');

      const consumerDone = consumeInteractions(q, mutex, ctx, abort.signal);
      await new Promise((r) => setTimeout(r, 50));

      expect(caughtError).toBeInstanceOf(InteractionAbortedError);
      expect(chat.sent).toEqual(['step 1']);
      // Status should NOT be 'failed' — aborted errors are swallowed
      expect(reg.currentState('github:12345')).toBeNull();

      abort.abort();
      await consumerDone;
    } finally {
      registerInteractionHandler(
        'notification' as InteractionEventKind,
        defaultHandler,
      );
    }
  });
});
