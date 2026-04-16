/**
 * In-memory async read-write lock.
 *
 * - Shared (read): multiple holders allowed concurrently
 * - Exclusive (write): single holder, waits for all readers to finish
 * - Writer-priority: pending exclusive waiter blocks new shared acquires
 */

export class AsyncRWLock {
  private _readers = 0;
  private _writer = false;
  private _waiters: Array<{ exclusive: boolean; resolve: () => void }> = [];

  get readers(): number {
    return this._readers;
  }

  get writerActive(): boolean {
    return this._writer;
  }

  acquireShared(): Promise<void> {
    if (!this._writer && !this._waiters.some((w) => w.exclusive)) {
      this._readers++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push({ exclusive: false, resolve });
    });
  }

  releaseShared(): void {
    this._readers--;
    this._drain();
  }

  acquireExclusive(): Promise<void> {
    if (!this._writer && this._readers === 0) {
      this._writer = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push({ exclusive: true, resolve });
    });
  }

  releaseExclusive(): void {
    this._writer = false;
    this._drain();
  }

  private _drain(): void {
    if (this._waiters.length === 0) return;

    // If first waiter is exclusive, grant only when no readers
    if (this._waiters[0].exclusive) {
      if (this._readers === 0 && !this._writer) {
        this._writer = true;
        this._waiters.shift()!.resolve();
      }
      return;
    }

    // Grant all leading shared waiters
    while (
      this._waiters.length > 0 &&
      !this._waiters[0].exclusive &&
      !this._writer
    ) {
      this._readers++;
      this._waiters.shift()!.resolve();
    }
  }
}
