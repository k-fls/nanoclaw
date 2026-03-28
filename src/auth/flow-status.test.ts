import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';

import { FlowStatusRegistry } from './flow-status.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Create a mock ServerResponse that captures written data. */
function mockResponse(): {
  res: import('http').ServerResponse;
  chunks: string[];
  headArgs: unknown[];
  ended: boolean;
} {
  const chunks: string[] = [];
  let headArgs: unknown[] = [];
  let ended = false;
  const stream = new PassThrough();
  const res = Object.assign(stream, {
    writeHead: vi.fn((...args: unknown[]) => {
      headArgs = args;
      return res;
    }),
    headersSent: false,
    end: vi.fn((data?: string) => {
      if (data) chunks.push(data);
      ended = true;
    }),
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
  }) as unknown as import('http').ServerResponse;
  return {
    res,
    chunks,
    headArgs,
    get ended() {
      return ended;
    },
  };
}

describe('FlowStatusRegistry', () => {
  it('emits and tracks events', () => {
    const reg = new FlowStatusRegistry();
    reg.emit('github:12345', 'github', 'queued', 'xdg-open shim');
    reg.emit('github:12345', 'github', 'active', 'presenting to user');

    expect(reg.currentState('github:12345')).toBe('active');
    expect(reg.events('github:12345')).toHaveLength(2);
    expect(reg.events('github:12345')[0].type).toBe('queued');
    expect(reg.events('github:12345')[1].type).toBe('active');
  });

  it('returns null for unknown flows', () => {
    const reg = new FlowStatusRegistry();
    expect(reg.currentState('nonexistent')).toBeNull();
    expect(reg.events('nonexistent')).toEqual([]);
  });

  it('tracks multiple flows independently', () => {
    const reg = new FlowStatusRegistry();
    reg.emit('github:1', 'github', 'queued', 'test');
    reg.emit('google:1', 'google', 'queued', 'test');
    reg.emit('github:1', 'github', 'completed', 'done');

    expect(reg.currentState('github:1')).toBe('completed');
    expect(reg.currentState('google:1')).toBe('queued');
  });

  it('listFlows returns all flows with current state', () => {
    const reg = new FlowStatusRegistry();
    reg.emit('github:1', 'github', 'queued', 'test');
    reg.emit('google:1', 'google', 'active', 'test');

    const flows = reg.listFlows();
    expect(flows).toHaveLength(2);

    const github = flows.find((f) => f.flowId === 'github:1');
    const google = flows.find((f) => f.flowId === 'google:1');
    expect(github).toEqual({
      flowId: 'github:1',
      state: 'queued',
      providerId: 'github',
    });
    expect(google).toEqual({
      flowId: 'google:1',
      state: 'active',
      providerId: 'google',
    });
  });

  it('events include timestamps', () => {
    const reg = new FlowStatusRegistry();
    const before = Date.now();
    reg.emit('f1', 'github', 'queued', 'test');
    const after = Date.now();

    const events = reg.events('f1');
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('destroy clears all state', () => {
    const reg = new FlowStatusRegistry();
    reg.emit('f1', 'github', 'queued', 'test');
    reg.destroy();
    expect(reg.listFlows()).toEqual([]);
  });

  // ── handleSSE ─────────────────────────────────────────────────

  describe('handleSSE', () => {
    it('writes SSE headers', () => {
      const reg = new FlowStatusRegistry();
      const { res, headArgs } = mockResponse();
      reg.handleSSE('flow-1', {} as import('http').IncomingMessage, res);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
    });

    it('replays existing events on connect', () => {
      const reg = new FlowStatusRegistry();
      reg.emit('flow-1', 'github', 'queued', 'queued by proxy');
      reg.emit('flow-1', 'github', 'active', 'presenting');

      const { res, chunks } = mockResponse();
      reg.handleSSE('flow-1', {} as import('http').IncomingMessage, res);

      // Should have replayed 2 events
      const eventLines = chunks.filter((c) => c.includes('event:'));
      expect(eventLines).toHaveLength(2);
      expect(eventLines[0]).toContain('event: queued');
      expect(eventLines[1]).toContain('event: active');
    });

    it('streams live events to subscribers', () => {
      const reg = new FlowStatusRegistry();
      const { res, chunks } = mockResponse();

      // Subscribe first
      reg.handleSSE('flow-2', {} as import('http').IncomingMessage, res);
      // Then emit
      reg.emit('flow-2', 'google', 'queued', 'test');

      const eventLines = chunks.filter((c) => c.includes('event: queued'));
      expect(eventLines).toHaveLength(1);
    });

    it('creates flow state for unknown flowId', () => {
      const reg = new FlowStatusRegistry();
      const { res } = mockResponse();
      reg.handleSSE('new-flow', {} as import('http').IncomingMessage, res);
      // Should not throw — just creates empty state
      expect(reg.currentState('new-flow')).toBeNull();
    });
  });

  // ── handleListFlows ───────────────────────────────────────────

  describe('handleListFlows', () => {
    it('returns JSON array of all flows', () => {
      const reg = new FlowStatusRegistry();
      reg.emit('f1', 'github', 'queued', 'test');
      reg.emit('f2', 'google', 'completed', 'done');

      const { res, chunks } = mockResponse();
      reg.handleListFlows({} as import('http').IncomingMessage, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'content-type': 'application/json',
      });
      const body = JSON.parse(chunks[0]);
      expect(body).toHaveLength(2);
      expect(body.find((f: { flowId: string }) => f.flowId === 'f1')).toEqual({
        flowId: 'f1',
        state: 'queued',
        providerId: 'github',
      });
    });

    it('returns empty array when no flows exist', () => {
      const reg = new FlowStatusRegistry();
      const { res, chunks } = mockResponse();
      reg.handleListFlows({} as import('http').IncomingMessage, res);
      expect(JSON.parse(chunks[0])).toEqual([]);
    });
  });

  // ── destroy with SSE subscribers ──────────────────────────────

  describe('destroy with subscribers', () => {
    it('ends all SSE connections', () => {
      const reg = new FlowStatusRegistry();
      const { res: res1 } = mockResponse();
      const { res: res2 } = mockResponse();
      reg.handleSSE('flow-1', {} as import('http').IncomingMessage, res1);
      reg.handleSSE('flow-2', {} as import('http').IncomingMessage, res2);

      reg.destroy();

      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).toHaveBeenCalled();
      expect(reg.listFlows()).toEqual([]);
    });
  });
});
