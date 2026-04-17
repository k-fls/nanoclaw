import { describe, expect, it } from 'vitest';
import {
  Version,
  compareVersion,
  detectPrefixMismatch,
  formatVersion,
  parseCascadeTag,
  parseUpstreamTag,
} from '../scripts/version.js';

const v = (a: number, b: number, c: number, d = 0): Version => ({ a, b, c, d });

describe('formatVersion', () => {
  it('formats a 4-part version', () => {
    expect(formatVersion(v(1, 9, 0, 5))).toBe('1.9.0.5');
  });
});

describe('compareVersion', () => {
  it('compares lexicographically over (A,B,C,D)', () => {
    expect(compareVersion(v(1, 9, 0, 5), v(1, 9, 0, 5))).toBe(0);
    expect(compareVersion(v(1, 9, 0, 4), v(1, 9, 0, 5))).toBeLessThan(0);
    expect(compareVersion(v(1, 9, 1, 0), v(1, 9, 0, 99))).toBeGreaterThan(0);
    expect(compareVersion(v(2, 0, 0, 0), v(1, 99, 99, 99))).toBeGreaterThan(0);
  });
});

describe('parseUpstreamTag', () => {
  it.each([
    ['v1.2.3', { a: 1, b: 2, c: 3, d: 0 }],
    ['1.2.3', { a: 1, b: 2, c: 3, d: 0 }],
    ['v0.0.1', { a: 0, b: 0, c: 1, d: 0 }],
  ])('parses %s', (tag, expected) => {
    expect(parseUpstreamTag(tag)).toEqual(expected);
  });
  it.each([
    ['v1.2', null],
    ['v1.2.3.4', null],
    ['release-1.2.3', null],
    ['core/1.2.3.4', null],
    ['', null],
  ])('rejects %s', (tag, expected) => {
    expect(parseUpstreamTag(tag)).toBe(expected);
  });
});

describe('parseCascadeTag', () => {
  it('parses correct prefix', () => {
    expect(parseCascadeTag('core/1.9.0.5', 'core')).toEqual({ a: 1, b: 9, c: 0, d: 5 });
    expect(parseCascadeTag('skill/reactions/1.9.0.2', 'skill/reactions')).toEqual({
      a: 1,
      b: 9,
      c: 0,
      d: 2,
    });
  });
  it('returns null when prefix mismatches', () => {
    expect(parseCascadeTag('core/1.9.0.5', 'module/foo')).toBeNull();
  });
  it('returns null when version is not 4-part', () => {
    expect(parseCascadeTag('core/1.9.0', 'core')).toBeNull();
    expect(parseCascadeTag('v1.2.3', 'core')).toBeNull();
  });
});

describe('detectPrefixMismatch', () => {
  const V = (name: string, a: number, b: number, c: number) => ({ name, version: v(a, b, c) });

  it('returns ok when all sources agree', () => {
    const r = detectPrefixMismatch(
      'edition/starter',
      [V('core', 1, 9, 0), V('channel/whatsapp', 1, 9, 0)],
      null,
    );
    expect(r.severity).toBe('ok');
    expect(r.chosen).toEqual({ a: 1, b: 9, c: 0, d: 0 });
  });

  it('errors on disagreement with no parent_branch', () => {
    const r = detectPrefixMismatch(
      'edition/starter',
      [V('core', 1, 9, 0), V('channel/whatsapp', 1, 8, 0)],
      null,
    );
    expect(r.severity).toBe('error');
    expect(r.chosen).toBeNull();
    expect(r.message).toMatch(/no .cascade\/parent_branch declared/);
  });

  it('warns + chooses source when parent_branch declares one', () => {
    const r = detectPrefixMismatch(
      'edition/starter',
      [V('core', 1, 9, 0), V('channel/whatsapp', 1, 8, 0)],
      'core',
    );
    expect(r.severity).toBe('warning');
    expect(r.chosen).toEqual({ a: 1, b: 9, c: 0, d: 0 });
  });

  it('errors if parent_branch names a non-source', () => {
    const r = detectPrefixMismatch(
      'edition/starter',
      [V('core', 1, 9, 0), V('channel/whatsapp', 1, 8, 0)],
      'module/nowhere',
    );
    expect(r.severity).toBe('error');
  });

  it('handles empty source list', () => {
    const r = detectPrefixMismatch('edition/empty', [], null);
    expect(r.severity).toBe('ok');
    expect(r.chosen).toBeNull();
  });
});
