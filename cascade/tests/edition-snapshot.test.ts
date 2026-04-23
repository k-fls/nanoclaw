import { describe, expect, it } from 'vitest';
import { computeSnapshot } from '../scripts/edition-snapshot.js';
import { parseTagBody, readTagBody, writeTag } from '../scripts/tags.js';
import { validateSnapshot } from '../scripts/snapshot-schema.js';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';

function buildEditionRepo() {
  const r = makeRepo();
  seedCascadeRegistry(r.root);
  r.write('README.md', 'r\n');
  r.commit('init');

  r.run('checkout', '-b', 'upstream/main');
  r.write('u.txt', 'u\n');
  r.commit('up');
  r.run('tag', '-a', 'v1.9.0', '-m', 'u190');

  r.run('checkout', '-b', 'core', 'v1.9.0');
  r.write('c.txt', 'c\n');
  r.commit('core-init');

  r.run('checkout', '-b', 'channel/telegram');
  r.write('src/channels/telegram/sender.ts', 'tg\n');
  r.commit('tg');

  r.run('checkout', '-b', 'channel/whatsapp', 'core');
  r.write('src/channels/whatsapp/sender.ts', 'wa\n');
  r.commit('wa');

  r.run('checkout', '-b', 'skill/image-vision', 'core');
  r.write('skills/image-vision.ts', 'iv\n');
  r.commit('iv');

  // Edition merges core + channels + skill.
  r.run('checkout', '-b', 'edition/starter', 'core');
  r.run('merge', '--no-ff', '-m', 'merge tg', 'channel/telegram');
  r.run('merge', '--no-ff', '-m', 'merge wa', 'channel/whatsapp');
  r.run('merge', '--no-ff', '-m', 'merge iv', 'skill/image-vision');
  return r;
}

describe('computeSnapshot', () => {
  it('includes merged channels and skills', () => {
    const r = buildEditionRepo();
    const snap = computeSnapshot({
      branch: 'edition/starter',
      version: { a: 1, b: 9, c: 0, d: 1 },
      repoRoot: r.root,
      now: () => new Date('2026-04-13T10:00:00Z'),
    });
    expect(snap.edition).toBe('starter');
    expect(snap.version).toBe('1.9.0.1');
    expect(snap.schema_version).toBe(1);
    expect(snap.included.channels.sort()).toEqual(['telegram', 'whatsapp']);
    expect(snap.included.skills).toEqual(['image-vision']);
    expect(snap.upstream_version).toBe('1.9.0');
    expect(snap.generated_at).toBe('2026-04-13T10:00:00.000Z');
  });

  it('produces identical output on fixed state (determinism)', () => {
    const r = buildEditionRepo();
    const args = {
      branch: 'edition/starter',
      version: { a: 1, b: 9, c: 0, d: 1 },
      repoRoot: r.root,
      now: () => new Date('2026-04-13T10:00:00Z'),
    } as const;
    const a = computeSnapshot(args);
    const b = computeSnapshot(args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produced snapshot passes validateSnapshot', () => {
    const r = buildEditionRepo();
    const snap = computeSnapshot({
      branch: 'edition/starter',
      version: { a: 1, b: 9, c: 0, d: 1 },
      repoRoot: r.root,
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  it('round-trips through writeTag + readTagBody + parseTagBody', () => {
    const r = buildEditionRepo();
    const snap = computeSnapshot({
      branch: 'edition/starter',
      version: { a: 1, b: 9, c: 0, d: 1 },
      repoRoot: r.root,
    });
    const res = writeTag(
      { branch: 'edition/starter', version: { a: 1, b: 9, c: 0, d: 1 }, snapshot: snap },
      r.root,
    );
    const body = readTagBody(res.tag, r.root);
    expect(body).not.toBeNull();
    const parsed = parseTagBody(body!);
    expect(parsed.snapshot).toEqual(snap);
  });

  it('throws for non-edition branches', () => {
    const r = buildEditionRepo();
    expect(() =>
      computeSnapshot({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 }, repoRoot: r.root }),
    ).toThrow(/not an edition/);
  });
});
