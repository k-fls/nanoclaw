import { describe, it, expect, vi } from 'vitest';

import {
  InteractionQueue,
  InteractionStatusRegistry,
  type InteractionEntry,
  type InteractionEventKind,
} from '../interaction/index.js';
import type { HandlerContext } from '../interaction/index.js';
import { _dedup as dedup } from './auth-handlers.js';

function entry(
  sourceId: string,
  eventType: InteractionEventKind,
  interactionId: string,
): InteractionEntry {
  return {
    interactionId,
    eventType,
    sourceId,
    eventParam: '',
    eventUrl: `https://example.com/${sourceId}`,
    replyFn: null,
  };
}

function ctx(queue?: InteractionQueue): HandlerContext {
  return {
    chat: {
      send: vi.fn(async () => {}),
      sendRaw: vi.fn(async () => {}),
      receive: vi.fn(async () => null),
      hideMessage: vi.fn(),
      advanceCursor: vi.fn(),
    },
    queue: queue ?? new InteractionQueue(),
    statusRegistry: new InteractionStatusRegistry(),
  };
}

describe('dedup', () => {
  it('returns entry unchanged when queue has no duplicates', () => {
    const c = ctx();
    const e = entry('github', 'oauth-start', 'github:0:abc');
    const result = dedup(e, c);
    expect(result).toBe(e);
  });

  it('returns newest queued entry and emits removed for current + older', () => {
    const q = new InteractionQueue();
    const c = ctx(q);

    // Queue has two more entries for the same provider/eventType
    const queued1 = entry('github', 'oauth-start', 'github:0:older');
    const queued2 = entry('github', 'oauth-start', 'github:0:newest');
    q.push(queued1, 'test');
    q.push(queued2, 'test');

    const current = entry('github', 'oauth-start', 'github:0:current');
    const result = dedup(current, c);

    expect(result.interactionId).toBe('github:0:newest');
    expect(q.length).toBe(0);

    // current + older both marked removed
    expect(c.statusRegistry.currentState('github:0:current')).toBe('removed');
    expect(c.statusRegistry.currentState('github:0:older')).toBe('removed');
  });

  it('does not extract entries for a different provider', () => {
    const q = new InteractionQueue();
    const c = ctx(q);

    q.push(entry('google', 'oauth-start', 'google:0:abc'), 'test');

    const current = entry('github', 'oauth-start', 'github:0:xyz');
    const result = dedup(current, c);

    expect(result).toBe(current);
    expect(q.length).toBe(1);
  });

  it('does not extract entries for a different eventType', () => {
    const q = new InteractionQueue();
    const c = ctx(q);

    q.push(entry('github', 'device-code', 'github:device:AAA'), 'test');

    const current = entry('github', 'oauth-start', 'github:0:xyz');
    const result = dedup(current, c);

    expect(result).toBe(current);
    expect(q.length).toBe(1);
  });

  it('works for device-code entries', () => {
    const q = new InteractionQueue();
    const c = ctx(q);

    q.push(entry('github', 'device-code', 'github:device:OLD'), 'test');

    const current = entry('github', 'device-code', 'github:device:NEW');
    const result = dedup(current, c);

    expect(result.interactionId).toBe('github:device:OLD');
    expect(c.statusRegistry.currentState('github:device:NEW')).toBe('removed');
    expect(q.length).toBe(0);
  });
});
