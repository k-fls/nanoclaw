import { describe, it, expect } from 'vitest';

import { FlowStatusRegistry } from './flow-status.js';

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
    expect(github).toEqual({ flowId: 'github:1', state: 'queued', providerId: 'github' });
    expect(google).toEqual({ flowId: 'google:1', state: 'active', providerId: 'google' });
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
});
