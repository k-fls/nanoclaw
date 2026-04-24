import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  AfterNoMatchError,
  executePropagate,
} from '../scripts/propagate.js';
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
  return r;
}

function tagList(r: { root: string }): string[] {
  const out = execFileSync('git', ['tag'], { cwd: r.root, encoding: 'utf8' }).trim();
  return out ? out.split('\n') : [];
}

describe('executePropagate — happy path', () => {
  it('writes core tag and advances channel (merge-only, no tag)', () => {
    const r = buildRepo();
    const result = executePropagate({ repoRoot: r.root, noFetch: true });
    expect(result.halted).toBeNull();
    const tags = result.tags_written.map((t) => t.tag);
    // Channels are carriers bound to core: propagate merges core into them
    // but writes no `channel/<name>/A.B.C.D` tag. Assert that first, then
    // confirm core itself was tagged.
    expect(tags).not.toContain('channel/telegram/1.9.0.1');
    expect(tagList(r)).not.toContain('channel/telegram/1.9.0.1');
    expect(tags).toContain('core/1.9.0.1');
    expect(tagList(r)).toContain('core/1.9.0.1');
    // The channel hop lands in progress.done even though it produces no
    // tag. (It may count as noop when core is already an ancestor of the
    // channel, or as advanced when a merge is actually needed — we only
    // care that it isn't stuck in pending.)
    const doneTargets = result.progress.done.map((h) => h.split(' -> ')[1]);
    expect(doneTargets).toContain('channel/telegram');
  });

  it('is idempotent: second run is all no-op', () => {
    const r = buildRepo();
    executePropagate({ repoRoot: r.root, noFetch: true });
    const second = executePropagate({ repoRoot: r.root, noFetch: true });
    expect(second.halted).toBeNull();
    expect(second.tags_written).toEqual([]);
    expect(second.summary.noop).toBeGreaterThan(0);
  });
});

describe('executePropagate — merge-conflict halt', () => {
  it('halts with merge-conflict and leaves HEAD on the halted target', () => {
    const r = buildRepo();
    // Tag core at its current tip (pre-divergence) so the first-bump
    // baseline for channel/telegram is derivable. Then introduce
    // conflicting edits on both sides of c.txt to force a real conflict
    // during propagate's merge into channel/telegram.
    r.run('checkout', 'core');
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 } }, r.root);

    r.run('checkout', 'channel/telegram');
    r.write('c.txt', 'telegram-version\n');
    r.commit('conflicting c.txt on telegram');

    r.run('checkout', 'core');
    r.write('c.txt', 'core-version-2\n');
    r.commit('change c.txt on core');

    const result = executePropagate({ repoRoot: r.root, noFetch: true });
    expect(result.halted).not.toBeNull();
    expect(result.halted?.kind).toBe('merge-conflict');
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: r.root,
      encoding: 'utf8',
    }).trim();
    expect(head).toBe('channel/telegram');
  });
});

describe('executePropagate — partial recovery', () => {
  it('writes missing tag when merge commit exists without tag', () => {
    // Exercises the partial-state recovery path in executeHop: a previous
    // run merged the source in but crashed before writing the tag. Uses an
    // edition target since modules/channels are not_versioned under the
    // carrier rule and so have no tag-recovery path.
    const r = buildRepo();
    // Tag core.
    r.run('checkout', 'core');
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 } }, r.root);
    // Create an edition that declares core as its parent_branch.
    r.run('checkout', '-b', 'edition/starter', 'core');
    writeFileSync(path.join(r.root, '.cascade', 'parent_branch'), 'core\n');
    r.run('add', '.cascade/parent_branch');
    r.run('commit', '-q', '-m', 'declare parent');
    // Advance core so there's something to propagate into the edition.
    r.run('checkout', 'core');
    r.write('more.txt', 'm\n');
    r.commit('advance core');
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 2 } }, r.root);
    // Merge core into edition/starter but don't tag — simulates a crash
    // between merge and tag-write on the previous run.
    r.run('checkout', 'edition/starter');
    r.run('merge', '--no-ff', '-m', 'merge core', 'core');
    // Partial state: merge done, tag missing. Re-run should just tag.
    const result = executePropagate({ repoRoot: r.root, noFetch: true });
    expect(result.halted).toBeNull();
    const tags = result.tags_written.map((t) => t.tag);
    // First-bump D=1 regardless of source's D — the edition has no prior
    // tag, so its first bump starts at 1.
    expect(tags).toContain('edition/starter/1.9.0.1');
  });
});

describe('executePropagate — --after session skip', () => {
  it('skips the named hop and advances independent siblings', () => {
    const r = buildRepo();
    // Add a second channel whose hop is independent of telegram.
    r.run('checkout', '-b', 'channel/whatsapp', 'core');
    r.write('wa.ts', 'wa\n');
    r.commit('wa');

    // Pre-tag core.
    r.run('checkout', 'core');
    writeTag({ branch: 'core', version: { a: 1, b: 9, c: 0, d: 1 } }, r.root);

    // Introduce a conflict on telegram.
    r.run('checkout', 'channel/telegram');
    r.write('c.txt', 'tg-local\n');
    r.commit('conflict-prep');
    r.run('checkout', 'core');
    r.write('c.txt', 'core-updated\n');
    r.commit('core-update');

    // First run halts on telegram.
    const first = executePropagate({ repoRoot: r.root, noFetch: true });
    expect(first.halted?.kind).toBe('merge-conflict');

    // Abort the merge so the tree is clean for the next run.
    try {
      execFileSync('git', ['merge', '--abort'], { cwd: r.root, stdio: 'ignore' });
    } catch {
      /* merge was aborted successfully, or no merge in progress */
    }

    // Second run with --after channel/telegram should skip and advance
    // channel/whatsapp.
    const second = executePropagate({
      repoRoot: r.root,
      noFetch: true,
      after: 'channel/telegram',
    });
    const tags = second.tags_written.map((t) => t.tag);
    // Channels are not_versioned, so no `channel/whatsapp/*` tag is
    // written. The --after skip is verified by whatsapp's hop landing in
    // progress.done (merge executed) while telegram remains pending.
    expect(tags).not.toContain('channel/whatsapp/1.9.0.1');
    const doneTargets = second.progress.done.map((h) => h.split(' -> ')[1]);
    const pendingTargets = second.progress.pending.map((h) => h.hop.split(' -> ')[1]);
    expect(doneTargets).toContain('channel/whatsapp');
    expect(pendingTargets).toContain('channel/telegram');
  });

  it('raises AfterNoMatchError when target has no pending hop', () => {
    const r = buildRepo();
    executePropagate({ repoRoot: r.root, noFetch: true });
    // Everything now done.
    expect(() =>
      executePropagate({ repoRoot: r.root, noFetch: true, after: 'channel/telegram' }),
    ).toThrow(AfterNoMatchError);
  });
});
