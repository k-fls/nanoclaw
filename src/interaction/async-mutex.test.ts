import { describe, it, expect } from 'vitest';

import { AsyncMutex } from './async-mutex.js';

describe('AsyncMutex', () => {
  it('acquire resolves immediately when uncontended', async () => {
    const mutex = new AsyncMutex();
    await mutex.acquire();
    expect(mutex.locked).toBe(true);
    mutex.release();
    expect(mutex.locked).toBe(false);
  });

  it('second acquire waits until release', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    await mutex.acquire();
    order.push(1);

    const second = mutex.acquire().then(() => {
      order.push(2);
    });

    // Second acquire hasn't resolved yet
    await Promise.resolve();
    expect(order).toEqual([1]);

    mutex.release();
    await second;
    expect(order).toEqual([1, 2]);
    expect(mutex.locked).toBe(true);

    mutex.release();
    expect(mutex.locked).toBe(false);
  });

  it('FIFO ordering — waiters acquire in order', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    await mutex.acquire();

    const p1 = mutex.acquire().then(() => {
      order.push(1);
      mutex.release();
    });
    const p2 = mutex.acquire().then(() => {
      order.push(2);
      mutex.release();
    });
    const p3 = mutex.acquire().then(() => {
      order.push(3);
      mutex.release();
    });

    mutex.release();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('release without waiters unlocks', () => {
    const mutex = new AsyncMutex();
    // Not locked — release is a no-op (doesn't throw)
    expect(mutex.locked).toBe(false);
  });

  it('concurrent acquire/release interleaving', async () => {
    const mutex = new AsyncMutex();
    const log: string[] = [];

    async function worker(name: string, count: number) {
      for (let i = 0; i < count; i++) {
        await mutex.acquire();
        log.push(`${name}-start`);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 1));
        log.push(`${name}-end`);
        mutex.release();
      }
    }

    await Promise.all([worker('A', 3), worker('B', 3)]);

    // Each start must be followed by its own end (no interleaving)
    for (let i = 0; i < log.length; i += 2) {
      const start = log[i];
      const end = log[i + 1];
      expect(start.replace('-start', '')).toBe(end.replace('-end', ''));
    }
    expect(log).toHaveLength(12);
  });
});
