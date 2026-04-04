/**
 * Minimal async mutex for chat ownership.
 *
 * Ensures only one consumer (e.g. flow consumer, streaming callback)
 * sends messages at a time. Uncontended acquire returns immediately.
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
