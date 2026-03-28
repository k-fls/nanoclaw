import { describe, it, expect, vi } from 'vitest';

import { createSessionContext } from './session-context.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('createSessionContext', () => {
  it('returns all required fields', () => {
    const ctx = createSessionContext('test-scope', () => null);
    expect(ctx.scope).toBe('test-scope');
    expect(ctx.pendingErrors).toBeDefined();
    expect(ctx.flowQueue).toBeDefined();
    expect(ctx.statusRegistry).toBeDefined();
    expect(typeof ctx.onAuthError).toBe('function');
  });

  it('wires flowQueue mutations to statusRegistry', () => {
    const ctx = createSessionContext('test-scope', () => null);

    // Push a flow entry — mutation callback should forward to status registry
    ctx.flowQueue.push(
      {
        flowId: 'flow-1',
        providerId: 'claude',
        url: 'https://example.com',
        deliveryFn: null,
      },
      'test push',
    );

    const state = ctx.statusRegistry.currentState('flow-1');
    expect(state).toBe('queued');
  });

  it('onAuthError records request ID when extractable', () => {
    const ctx = createSessionContext('test-scope', (body) => {
      const m = body.match(/"request_id":\s*"(\w+)"/);
      return m ? m[1] : null;
    });

    ctx.onAuthError('{"request_id": "req123", "error": "unauthorized"}', 401);

    expect(ctx.pendingErrors.has('req123')).toBe(true);
  });

  it('onAuthError does not record when request ID is not extractable', () => {
    const ctx = createSessionContext('test-scope', () => null);

    ctx.onAuthError('no request id here', 401);

    expect(ctx.pendingErrors.size).toBe(0);
  });

  it('creates independent instances per call', () => {
    const ctx1 = createSessionContext('scope-1', () => null);
    const ctx2 = createSessionContext('scope-2', () => null);

    expect(ctx1.scope).toBe('scope-1');
    expect(ctx2.scope).toBe('scope-2');
    expect(ctx1.pendingErrors).not.toBe(ctx2.pendingErrors);
    expect(ctx1.flowQueue).not.toBe(ctx2.flowQueue);
    expect(ctx1.statusRegistry).not.toBe(ctx2.statusRegistry);
  });
});
