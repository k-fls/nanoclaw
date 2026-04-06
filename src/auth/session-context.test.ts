import { describe, it, expect, vi } from 'vitest';

import { createSessionContext } from './session-context.js';
import {
  InteractionQueue,
  InteractionStatusRegistry,
} from '../interaction/index.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeQueue(): InteractionQueue {
  return new InteractionQueue();
}

function makeRegistry(): InteractionStatusRegistry {
  return new InteractionStatusRegistry();
}

describe('createSessionContext', () => {
  it('returns all required fields', () => {
    const q = makeQueue();
    const r = makeRegistry();
    const ctx = createSessionContext('test-scope', () => null, q, r);
    expect(ctx.scope).toBe('test-scope');
    expect(ctx.pendingErrors).toBeDefined();
    expect(ctx.interactionQueue).toBe(q);
    expect(ctx.statusRegistry).toBe(r);
    expect(typeof ctx.onAuthError).toBe('function');
  });

  it('uses the provided queue and status registry', () => {
    const q = makeQueue();
    const r = makeRegistry();
    const ctx = createSessionContext('test-scope', () => null, q, r);

    expect(ctx.interactionQueue).toBe(q);
    expect(ctx.statusRegistry).toBe(r);
  });

  it('onAuthError records request ID when extractable', () => {
    const ctx = createSessionContext('test-scope', (body) => {
      const m = body.match(/"request_id":\s*"(\w+)"/);
      return m ? m[1] : null;
    }, makeQueue(), makeRegistry());

    ctx.onAuthError('{"request_id": "req123", "error": "unauthorized"}', 401);

    expect(ctx.pendingErrors.has('req123')).toBe(true);
  });

  it('onAuthError does not record when request ID is not extractable', () => {
    const ctx = createSessionContext('test-scope', () => null, makeQueue(), makeRegistry());

    ctx.onAuthError('no request id here', 401);

    expect(ctx.pendingErrors.size).toBe(0);
  });

  it('creates independent pendingErrors per call', () => {
    const ctx1 = createSessionContext('scope-1', () => null, makeQueue(), makeRegistry());
    const ctx2 = createSessionContext('scope-2', () => null, makeQueue(), makeRegistry());

    expect(ctx1.scope).toBe('scope-1');
    expect(ctx2.scope).toBe('scope-2');
    expect(ctx1.pendingErrors).not.toBe(ctx2.pendingErrors);
  });
});
