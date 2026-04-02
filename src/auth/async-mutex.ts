/**
 * Minimal async mutex for chat ownership.
 *
 * Two users: streaming callback and FIFO queue consumer.
 * Uncontended acquire returns immediately (zero overhead).
 */

export class AsyncMutex {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  get locked(): boolean {
    return this._locked;
  }

  acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  release(): void {
    if (this._waiters.length > 0) {
      // Hand lock to next waiter (FIFO)
      const next = this._waiters.shift()!;
      // Keep _locked = true — ownership transfers
      next();
    } else {
      this._locked = false;
    }
  }
}
