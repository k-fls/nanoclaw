import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  SNAPSHOT_FENCE_CLOSE,
  SNAPSHOT_FENCE_OPEN,
  TagExistsError,
  composeTagBody,
  isEditionBranch,
  parseTagBody,
  readTagBody,
  writeTag,
} from '../scripts/tags.js';
import { makeRepo } from './fixtures.js';

const V = (a: number, b: number, c: number, d: number) => ({ a, b, c, d });

describe('composeTagBody', () => {
  it('emits header, blank, notes, no fences when snapshot absent', () => {
    const body = composeTagBody({
      branch: 'core',
      version: V(1, 9, 0, 1),
      notes: 'release notes here',
    });
    expect(body).toBe('core 1.9.0.1\n\nrelease notes here\n');
  });

  it('emits fence block when snapshot is present', () => {
    const body = composeTagBody({
      branch: 'edition/starter',
      version: V(1, 9, 0, 1),
      notes: 'n',
      snapshot: { schema_version: 1, edition: 'starter' },
    });
    expect(body).toContain(SNAPSHOT_FENCE_OPEN);
    expect(body).toContain(SNAPSHOT_FENCE_CLOSE);
    expect(body).toContain('"schema_version": 1');
  });

  it('omits notes line as empty when not supplied', () => {
    const body = composeTagBody({ branch: 'core', version: V(1, 9, 0, 1) });
    expect(body).toBe('core 1.9.0.1\n\n\n');
  });

  it('is deterministic across calls', () => {
    const args = {
      branch: 'edition/starter',
      version: V(1, 9, 0, 1),
      notes: 'r',
      snapshot: { edition: 'starter', schema_version: 1 },
    };
    expect(composeTagBody(args)).toBe(composeTagBody(args));
  });
});

describe('parseTagBody', () => {
  it('round-trips with snapshot', () => {
    const snap = { schema_version: 1, edition: 'x' };
    const body = composeTagBody({
      branch: 'edition/x',
      version: V(1, 0, 0, 1),
      notes: 'n',
      snapshot: snap,
    });
    const parsed = parseTagBody(body);
    expect(parsed.header).toBe('edition/x 1.0.0.1');
    expect(parsed.notes).toBe('n');
    expect(parsed.snapshot).toEqual(snap);
  });

  it('round-trips without snapshot', () => {
    const body = composeTagBody({ branch: 'core', version: V(1, 9, 0, 1), notes: 'n' });
    const parsed = parseTagBody(body);
    expect(parsed.snapshot).toBeNull();
    expect(parsed.header).toBe('core 1.9.0.1');
    expect(parsed.notes).toBe('n');
  });

  it('rejects malformed fence', () => {
    expect(() => parseTagBody(`core 1.0.0.1\n\n\n${SNAPSHOT_FENCE_OPEN}\n{}\n`)).toThrow(
      /malformed snapshot fence/,
    );
  });
});

describe('isEditionBranch', () => {
  it.each([
    ['edition/starter', true],
    ['edition/foo', true],
    ['edition/a/b', false],
    ['core', false],
    ['channel/edition', false],
  ])('%s -> %s', (b, exp) => {
    expect(isEditionBranch(b)).toBe(exp);
  });
});

describe('writeTag', () => {
  function setup() {
    const r = makeRepo();
    r.write('README.md', 'r\n');
    r.commit('init');
    r.run('checkout', '-b', 'core');
    r.write('a.txt', 'a\n');
    r.commit('core-work');
    return r;
  }

  it('writes an annotated tag with the expected body', () => {
    const r = setup();
    const res = writeTag({ branch: 'core', version: V(1, 9, 0, 1), notes: 'hello' }, r.root);
    expect(res.tag).toBe('core/1.9.0.1');
    // Annotated tag confirmed by --format=%(objecttype).
    const objectType = execFileSync('git', [
      'for-each-ref',
      '--format=%(objecttype)',
      `refs/tags/${res.tag}`,
    ], { cwd: r.root, encoding: 'utf8' }).trim();
    expect(objectType).toBe('tag');
    const body = readTagBody(res.tag, r.root);
    expect(body).toContain('core 1.9.0.1');
    expect(body).toContain('hello');
  });

  it('refuses to overwrite an existing tag (same branch+version)', () => {
    const r = setup();
    writeTag({ branch: 'core', version: V(1, 9, 0, 1) }, r.root);
    expect(() =>
      writeTag({ branch: 'core', version: V(1, 9, 0, 1) }, r.root),
    ).toThrow(TagExistsError);
  });

  it('rejects non-edition snapshot', () => {
    const r = setup();
    expect(() =>
      writeTag(
        { branch: 'core', version: V(1, 9, 0, 1), snapshot: { schema_version: 1 } },
        r.root,
      ),
    ).toThrow(/not an edition/);
  });

  it('requires snapshot on edition branch', () => {
    const r = setup();
    r.run('checkout', '-b', 'edition/starter');
    expect(() =>
      writeTag({ branch: 'edition/starter', version: V(1, 9, 0, 1) }, r.root),
    ).toThrow(/no snapshot/);
  });

  it('writes an edition tag with snapshot fence', () => {
    const r = setup();
    r.run('checkout', '-b', 'edition/starter');
    const snap = { schema_version: 1, edition: 'starter' };
    const res = writeTag(
      { branch: 'edition/starter', version: V(1, 9, 0, 1), snapshot: snap },
      r.root,
    );
    const body = readTagBody(res.tag, r.root)!;
    expect(body).toContain(SNAPSHOT_FENCE_OPEN);
    const parsed = parseTagBody(body);
    expect(parsed.snapshot).toEqual(snap);
  });
});
