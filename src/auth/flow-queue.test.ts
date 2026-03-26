import { describe, it, expect, vi } from 'vitest';

import { FlowQueue, type FlowEntry } from './flow-queue.js';

function entry(providerId: string, flowId?: string): FlowEntry {
  return {
    flowId: flowId ?? `${providerId}:12345`,
    providerId,
    url: `https://example.com/auth?provider=${providerId}`,
    deliveryFn: vi.fn(async () => ({ ok: true })),
  };
}

describe('FlowQueue', () => {
  describe('push', () => {
    it('adds entries and reports length', () => {
      const q = new FlowQueue();
      q.push(entry('github'), 'test');
      q.push(entry('google'), 'test');
      expect(q.length).toBe(2);
    });

    it('deduplicates by providerId — removes old, adds new at end', () => {
      const q = new FlowQueue();
      const mutations: string[] = [];
      q.onMutation((_fid, pid, event) => mutations.push(`${event}:${pid}`));

      q.push(entry('github', 'github:1'), 'first');
      q.push(entry('google', 'google:1'), 'second');
      q.push(entry('github', 'github:2'), 'replaced');

      expect(q.length).toBe(2);
      // Old github was removed, new one added
      expect(mutations).toEqual([
        'queued:github',
        'queued:google',
        'removed:github',
        'queued:github',
      ]);
    });

    it('fires mutation callback with reason', () => {
      const q = new FlowQueue();
      const reasons: string[] = [];
      q.onMutation((_fid, _pid, _event, reason) => reasons.push(reason));

      q.push(entry('github'), 'xdg-open shim');
      expect(reasons).toEqual(['xdg-open shim']);
    });
  });

  describe('waitForEntry', () => {
    it('returns immediately if entries exist', async () => {
      const q = new FlowQueue();
      q.push(entry('github'), 'test');

      const abort = new AbortController();
      const result = await q.waitForEntry(abort.signal);
      expect(result).not.toBeNull();
      expect(result!.providerId).toBe('github');
      expect(q.length).toBe(0);
    });

    it('blocks until push, then returns', async () => {
      const q = new FlowQueue();
      const abort = new AbortController();

      let resolved = false;
      const promise = q.waitForEntry(abort.signal).then((e) => {
        resolved = true;
        return e;
      });

      // Not resolved yet
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Push wakes the consumer
      q.push(entry('github'), 'test');
      const result = await promise;
      expect(resolved).toBe(true);
      expect(result!.providerId).toBe('github');
    });

    it('returns null on abort', async () => {
      const q = new FlowQueue();
      const abort = new AbortController();

      const promise = q.waitForEntry(abort.signal);
      abort.abort();
      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null if already aborted', async () => {
      const q = new FlowQueue();
      const abort = new AbortController();
      abort.abort();

      const result = await q.waitForEntry(abort.signal);
      expect(result).toBeNull();
    });

    it('pops FIFO', async () => {
      const q = new FlowQueue();
      q.push(entry('github'), 'test');
      q.push(entry('google'), 'test');
      q.push(entry('slack'), 'test');

      const abort = new AbortController();
      const r1 = await q.waitForEntry(abort.signal);
      const r2 = await q.waitForEntry(abort.signal);
      const r3 = await q.waitForEntry(abort.signal);

      expect(r1!.providerId).toBe('github');
      expect(r2!.providerId).toBe('google');
      expect(r3!.providerId).toBe('slack');
    });
  });

  describe('hasProvider', () => {
    it('returns true when provider has pending entry', () => {
      const q = new FlowQueue();
      q.push(entry('github'), 'test');
      expect(q.hasProvider('github')).toBe(true);
    });

    it('returns false when provider has no pending entry', () => {
      const q = new FlowQueue();
      q.push(entry('github'), 'test');
      expect(q.hasProvider('slack')).toBe(false);
    });
  });

  describe('hasProvider', () => {
    it('returns true for existing provider', () => {
      const q = new FlowQueue();
      q.push(entry('github'), 'test');
      expect(q.hasProvider('github')).toBe(true);
    });

    it('returns false for missing provider', () => {
      const q = new FlowQueue();
      expect(q.hasProvider('github')).toBe(false);
    });
  });
});
