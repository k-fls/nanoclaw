import { describe, it, expect } from 'vitest';

import { PendingAuthErrors } from './pending-auth-errors.js';

describe('PendingAuthErrors', () => {
  it('record and has', () => {
    const p = new PendingAuthErrors();
    expect(p.has('req_123')).toBe(false);

    p.record('req_123');
    expect(p.has('req_123')).toBe(true);
    expect(p.has('req_456')).toBe(false);
    expect(p.size).toBe(1);
  });

  it('clear removes all entries', () => {
    const p = new PendingAuthErrors();
    p.record('req_1');
    p.record('req_2');
    expect(p.size).toBe(2);

    p.clear();
    expect(p.size).toBe(0);
    expect(p.has('req_1')).toBe(false);
  });

  it('duplicate records are idempotent', () => {
    const p = new PendingAuthErrors();
    p.record('req_1');
    p.record('req_1');
    expect(p.size).toBe(1);
  });
});
