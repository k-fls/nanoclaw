import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { planPropagation, toEnvelope } from '../scripts/propagate.js';
import { writeTag } from '../scripts/tags.js';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';

function buildRepo() {
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
  r.write('tg.ts', 'tg\n');
  r.commit('tg');

  r.run('checkout', '-b', 'channel/whatsapp', 'core');
  r.write('wa.ts', 'wa\n');
  r.commit('wa');
  return r;
}

describe('planPropagation', () => {
  it('enumerates core → channels hops with core-first ordering', () => {
    const r = buildRepo();
    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    expect(plan.preflight_halt).toBeNull();
    const hopNames = plan.hops.map((h) => h.hop);
    // Upstream → core should come first (level 1 target).
    expect(hopNames[0]).toMatch(/-> core$/);
    // All remaining hops target channels (level 2).
    for (const h of plan.hops.slice(1)) {
      expect(h.target).toMatch(/^channel\//);
      expect(h.source).toBe('core');
    }
    // Channels sorted lexicographically.
    const channels = plan.hops.slice(1).map((h) => h.target);
    expect(channels).toEqual(['channel/telegram', 'channel/whatsapp']);
  });

  it('predicts first-bump version', () => {
    const r = buildRepo();
    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    const coreHop = plan.hops.find((h) => h.target === 'core')!;
    expect(coreHop.status).toBe('pending');
    expect(coreHop.predicted_tag).toBe('core/1.9.0.1');
  });

  it('marks hop done after tag exists and branch has not moved', () => {
    const r = buildRepo();
    r.run('checkout', 'core');
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 } }, r.root);
    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    const coreHop = plan.hops.find((h) => h.target === 'core')!;
    expect(coreHop.status).toBe('done');
    expect(coreHop.predicted_tag).toBeNull();
  });

  it('pre-flight bad-state halts when working tree is dirty', () => {
    const r = buildRepo();
    r.write('dirty.txt', 'x\n'); // write without committing
    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    expect(plan.preflight_halt?.kind).toBe('bad-state');
    expect(plan.hops).toHaveLength(0);
  });

  it('envelope has halted:null + empty pending on clean fully-merged repo', () => {
    const r = buildRepo();
    r.run('checkout', 'core');
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 } }, r.root);
    // Channels are not_versioned; "done" is derived from source-ancestor,
    // not from a channel tag. Merge core into each channel to advance them.
    r.run('checkout', 'channel/telegram');
    r.run('merge', '--no-ff', '-m', 'merge core', 'core');
    r.run('checkout', 'channel/whatsapp');
    r.run('merge', '--no-ff', '-m', 'merge core', 'core');
    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    const env = toEnvelope(plan);
    expect(env.halted).toBeNull();
    expect(env.progress.pending).toEqual([]);
    expect(env.progress.done.length).toBeGreaterThan(0);
  });

  it('channel hops carry no predicted_tag (not_versioned carriers)', () => {
    const r = buildRepo();
    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    const channelHops = plan.hops.filter((h) => h.target.startsWith('channel/'));
    expect(channelHops.length).toBeGreaterThan(0);
    for (const h of channelHops) {
      expect(h.predicted_tag).toBeNull();
      expect(h.predicted_version).toBeNull();
    }
  });
});

describe('dry-run determinism', () => {
  it('produces byte-identical JSON on two consecutive invocations', () => {
    const r = buildRepo();
    const a = JSON.stringify(toEnvelope(planPropagation({ repoRoot: r.root, noFetch: true })));
    const b = JSON.stringify(toEnvelope(planPropagation({ repoRoot: r.root, noFetch: true })));
    expect(a).toBe(b);
  });

  it('byte-identical across clean and stable states with channels', () => {
    const r = buildRepo();
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 } }, r.root);
    const a = JSON.stringify(toEnvelope(planPropagation({ repoRoot: r.root, noFetch: true })));
    const b = JSON.stringify(toEnvelope(planPropagation({ repoRoot: r.root, noFetch: true })));
    expect(a).toBe(b);
  });
});

describe('editions in plan', () => {
  it('emits core → edition and channel → edition hops', () => {
    const r = buildRepo();
    // Build an edition that merges core + telegram.
    r.run('checkout', '-b', 'edition/starter', 'core');
    writeFileSync(path.join(r.root, '.cascade', 'parent_branch'), 'core\n');
    r.run('add', '.cascade/parent_branch');
    r.run('commit', '-q', '-m', 'declare parent');
    r.run('merge', '--no-ff', '-m', 'merge tg', 'channel/telegram');

    const plan = planPropagation({ repoRoot: r.root, noFetch: true });
    const editionHops = plan.hops.filter((h) => h.target === 'edition/starter');
    const sources = editionHops.map((h) => h.source);
    // core must appear first, channel/telegram follows.
    expect(sources[0]).toBe('core');
    expect(sources).toContain('channel/telegram');
  });
});
