import { describe, it, expect, vi } from 'vitest';

import { InteractionQueue, type InteractionEntry } from './queue.js';

function entry(sourceId: string, interactionId?: string): InteractionEntry {
  return {
    interactionId: interactionId ?? `${sourceId}:12345`,
    eventType: 'notification',
    sourceId,
    eventParam: `https://example.com/flow?source=${sourceId}`,
    replyFn: vi.fn(async () => ({ done: true })),
  };
}

describe('InteractionQueue', () => {
  describe('push', () => {
    it('adds entries and reports length', () => {
      const q = new InteractionQueue();
      q.push(entry('github'), 'test');
      q.push(entry('google'), 'test');
      expect(q.length).toBe(2);
    });

    it('fires mutation callback with reason', () => {
      const q = new InteractionQueue();
      const reasons: string[] = [];
      q.onMutation((_id, _et, _event, reason) => reasons.push(reason));

      q.push(entry('github'), 'xdg-open shim');
      expect(reasons).toEqual(['xdg-open shim']);
    });

    it('does not dedup — callers use extract for that', () => {
      const q = new InteractionQueue();
      q.push(entry('github', 'github:1'), 'first');
      q.push(entry('github', 'github:2'), 'second');
      expect(q.length).toBe(2);
    });
  });

  describe('extract', () => {
    it('removes matching entries and returns them', () => {
      const q = new InteractionQueue();
      const mutations: string[] = [];
      q.onMutation((id, _et, event) => mutations.push(`${event}:${id}`));

      q.push(entry('github', 'github:1'), 'first');
      q.push(entry('google', 'google:1'), 'second');
      q.push(entry('github', 'github:2'), 'third');

      const extracted = q.extract((e) => e.sourceId === 'github', 'superseded');

      expect(extracted).toHaveLength(2);
      expect(extracted[0].interactionId).toBe('github:1');
      expect(extracted[1].interactionId).toBe('github:2');
      expect(q.length).toBe(1); // only google left
      expect(mutations).toContain('removed:github:1');
      expect(mutations).toContain('removed:github:2');
    });

    it('returns empty array when nothing matches', () => {
      const q = new InteractionQueue();
      q.push(entry('github'), 'test');

      const extracted = q.extract((e) => e.sourceId === 'slack', 'nope');
      expect(extracted).toHaveLength(0);
      expect(q.length).toBe(1);
    });
  });

  describe('waitForEntry', () => {
    it('returns immediately if entries exist', async () => {
      const q = new InteractionQueue();
      q.push(entry('github'), 'test');

      const abort = new AbortController();
      const result = await q.waitForEntry(abort.signal);
      expect(result).not.toBeNull();
      expect(result!.sourceId).toBe('github');
      expect(q.length).toBe(0);
    });

    it('blocks until push, then returns', async () => {
      const q = new InteractionQueue();
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
      expect(result!.sourceId).toBe('github');
    });

    it('returns null on abort', async () => {
      const q = new InteractionQueue();
      const abort = new AbortController();

      const promise = q.waitForEntry(abort.signal);
      abort.abort();
      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null if already aborted', async () => {
      const q = new InteractionQueue();
      const abort = new AbortController();
      abort.abort();

      const result = await q.waitForEntry(abort.signal);
      expect(result).toBeNull();
    });

    it('pops FIFO', async () => {
      const q = new InteractionQueue();
      q.push(entry('github'), 'test');
      q.push(entry('google'), 'test');
      q.push(entry('slack'), 'test');

      const abort = new AbortController();
      const r1 = await q.waitForEntry(abort.signal);
      const r2 = await q.waitForEntry(abort.signal);
      const r3 = await q.waitForEntry(abort.signal);

      expect(r1!.sourceId).toBe('github');
      expect(r2!.sourceId).toBe('google');
      expect(r3!.sourceId).toBe('slack');
    });
  });

  describe('has', () => {
    it('returns true when predicate matches', () => {
      const q = new InteractionQueue();
      q.push(entry('github'), 'test');
      expect(q.has((e) => e.sourceId === 'github')).toBe(true);
    });

    it('returns false when predicate does not match', () => {
      const q = new InteractionQueue();
      q.push(entry('github'), 'test');
      expect(q.has((e) => e.sourceId === 'slack')).toBe(false);
    });

    it('returns false on empty queue', () => {
      const q = new InteractionQueue();
      expect(q.has((e) => e.sourceId === 'github')).toBe(false);
    });
  });
});
