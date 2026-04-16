import { describe, it, expect } from 'vitest';

import { AsyncRWLock } from './async-rw-lock.js';

describe('AsyncRWLock', () => {
  it('shared acquire resolves immediately when uncontended', async () => {
    const lock = new AsyncRWLock();
    await lock.acquireShared();
    expect(lock.readers).toBe(1);
    lock.releaseShared();
    expect(lock.readers).toBe(0);
  });

  it('multiple shared acquires succeed concurrently', async () => {
    const lock = new AsyncRWLock();
    await lock.acquireShared();
    await lock.acquireShared();
    await lock.acquireShared();
    expect(lock.readers).toBe(3);
    lock.releaseShared();
    lock.releaseShared();
    lock.releaseShared();
    expect(lock.readers).toBe(0);
  });

  it('exclusive acquire resolves immediately when uncontended', async () => {
    const lock = new AsyncRWLock();
    await lock.acquireExclusive();
    expect(lock.writerActive).toBe(true);
    lock.releaseExclusive();
    expect(lock.writerActive).toBe(false);
  });

  it('exclusive waits for shared to release', async () => {
    const lock = new AsyncRWLock();
    const order: string[] = [];

    await lock.acquireShared();
    order.push('shared-acquired');

    const exPromise = lock.acquireExclusive().then(() => {
      order.push('exclusive-acquired');
    });

    await Promise.resolve();
    expect(order).toEqual(['shared-acquired']);

    lock.releaseShared();
    await exPromise;
    expect(order).toEqual(['shared-acquired', 'exclusive-acquired']);
    lock.releaseExclusive();
  });

  it('shared waits for exclusive to release', async () => {
    const lock = new AsyncRWLock();
    const order: string[] = [];

    await lock.acquireExclusive();
    order.push('exclusive-acquired');

    const shPromise = lock.acquireShared().then(() => {
      order.push('shared-acquired');
    });

    await Promise.resolve();
    expect(order).toEqual(['exclusive-acquired']);

    lock.releaseExclusive();
    await shPromise;
    expect(order).toEqual(['exclusive-acquired', 'shared-acquired']);
    lock.releaseShared();
  });

  it('writer-priority: pending exclusive blocks new shared', async () => {
    const lock = new AsyncRWLock();
    const order: string[] = [];

    await lock.acquireShared();

    // Exclusive waiter queues up
    const exPromise = lock.acquireExclusive().then(() => {
      order.push('exclusive');
      lock.releaseExclusive();
    });

    // New shared should wait behind the exclusive waiter
    const shPromise = lock.acquireShared().then(() => {
      order.push('shared');
      lock.releaseShared();
    });

    await Promise.resolve();
    expect(order).toEqual([]);

    lock.releaseShared();
    await exPromise;
    await shPromise;
    expect(order).toEqual(['exclusive', 'shared']);
  });

  it('multiple shared waiters granted together after exclusive releases', async () => {
    const lock = new AsyncRWLock();

    await lock.acquireExclusive();

    let sharedCount = 0;
    const promises = [1, 2, 3].map(() =>
      lock.acquireShared().then(() => {
        sharedCount++;
      }),
    );

    await Promise.resolve();
    expect(sharedCount).toBe(0);

    lock.releaseExclusive();
    await Promise.all(promises);
    expect(sharedCount).toBe(3);
    expect(lock.readers).toBe(3);

    lock.releaseShared();
    lock.releaseShared();
    lock.releaseShared();
  });
});
