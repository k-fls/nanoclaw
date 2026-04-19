import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  assembleDiscardedInput,
  assembleIntroducedInput,
  runInspect,
  runPool,
  type InspectorInput,
  type Verdict,
} from '../scripts/inspect.js';
import { analyzeIntake } from '../scripts/intake-analyze.js';
import { makeRepo, seedCascadeRegistry } from './fixtures.js';

describe('runPool concurrency', () => {
  it('respects concurrency cap and preserves input order in results', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    let active = 0;
    let peak = 0;
    const results = await runPool(items, 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('propagates worker errors', async () => {
    await expect(
      runPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

const MANY_LINES = Array.from({ length: 55 }, (_, i) => `L${i}`).join('\n') + '\n';

describe('input assembly (introduced)', () => {
  it('preloads upstream_tip_content, sets base_content to empty for introduced files, and omits port_hints for non-JS/TS', async () => {
    const repo = makeRepo();
    seedCascadeRegistry(repo.root);
    repo.write('README.md', 'initial\n');
    const base = repo.commit('base');

    repo.checkout('main');
    repo.branch('upstream', base);
    repo.checkout('upstream');
    repo.write('new-skill/SKILL.md', '# new skill\n' + MANY_LINES);
    repo.commit('add new-skill');

    repo.checkout('main');

    const analyzer = analyzeIntake({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream',
    });
    expect(analyzer.introducedGroups.length).toBeGreaterThan(0);
    const group = analyzer.introducedGroups[0]!;

    const input = assembleIntroducedInput(group, {
      repoRoot: repo.root,
      base: analyzer.base,
      source: analyzer.source,
    });

    expect(input.inspection_kind).toBe('introduced');
    expect(input.component_id).toBe(group.component.id);
    expect(input.commits.length).toBe(group.component.commits.length);
    const focus = input.focus_files.find((f) => f.path.endsWith('SKILL.md'));
    expect(focus).toBeDefined();
    expect(focus!.base_content).toBe('');
    expect(focus!.upstream_tip_content).toContain('# new skill');
    expect(focus!.port_hints).toBeUndefined();
  });

  it('computes port_hints for TS focus files when exports match target tree', async () => {
    const repo = makeRepo();
    seedCascadeRegistry(repo.root);
    // Target has a src/ using a symbol that upstream also exports.
    repo.write('src/app.ts', "import { helperFn } from './helper.js';\nhelperFn();\n");
    repo.write('src/helper.ts', 'export function helperFn() {}\n');
    const base = repo.commit('base');

    repo.checkout('main');
    repo.branch('upstream', base);
    repo.checkout('upstream');
    // Upstream introduces a *new* file re-exporting a symbol named helperFn
    // whose name matches a symbol target already uses.
    repo.write(
      'container/skills/newthing.ts',
      'export function helperFn() {\n  return 1;\n}\n' + MANY_LINES,
    );
    repo.commit('add newthing');

    repo.checkout('main');

    const analyzer = analyzeIntake({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream',
    });
    const group = analyzer.introducedGroups.find((g) =>
      g.introducedFiles.some((f) => f.path === 'container/skills/newthing.ts'),
    );
    expect(group).toBeDefined();

    const input = assembleIntroducedInput(group!, {
      repoRoot: repo.root,
      base: analyzer.base,
      source: analyzer.source,
      computePortHintsFn: (focusPath, upstreamContent) => {
        // Stub: simulate rg-based symbol-hint lookup. The real function calls
        // out to `rg`, which is a binary in user envs but a shell function in
        // this test sandbox — so we exercise the plumbing with a deterministic
        // fake and trust the production path separately.
        if (!upstreamContent.includes('helperFn')) return undefined;
        return '# helperFn\nsrc/app.ts:1:import { helperFn } from \'./helper.js\';';
      },
    });
    const focus = input.focus_files.find((f) => f.path === 'container/skills/newthing.ts');
    expect(focus?.port_hints).toBeDefined();
    expect(focus!.port_hints!).toContain('helperFn');
  });
});

describe('runInspect end-to-end with injected dispatch', () => {
  it('assembles inputs, dispatches via hook, writes one verdict per component, and reports progress', async () => {
    const repo = makeRepo();
    seedCascadeRegistry(repo.root);
    repo.write('README.md', 'base\n');
    const base = repo.commit('base');

    repo.checkout('main');
    repo.branch('upstream', base);
    repo.checkout('upstream');
    repo.write('feat-a/file.md', MANY_LINES);
    repo.commit('add feat-a');
    repo.write('feat-b/file.md', MANY_LINES);
    repo.commit('add feat-b');
    repo.checkout('main');

    const analyzer = analyzeIntake({
      repoRoot: repo.root,
      target: 'main',
      source: 'upstream',
    });
    expect(analyzer.introducedGroups.length).toBeGreaterThan(0);

    const dispatchCalls: InspectorInput[] = [];
    const cannedVerdict = (input: InspectorInput): Verdict => ({
      component_id: input.component_id,
      inspection_kind: input.inspection_kind,
      group_header: 'all-adopt',
      commit_verdicts: input.commits.map((c) => ({
        sha: c.sha,
        verdict: 'adopt' as const,
        escalation_reason: '',
      })),
      feature_narratives: [
        {
          title: 'test feature',
          commits: input.commits.map((c) => c.sha),
          description: 'canned',
        },
      ],
    });

    const progressEvents: { phase: string; kind: string; index: number }[] = [];

    const result = await runInspect({
      analyzerJson: JSON.stringify(analyzer),
      repoRoot: repo.root,
      discardedAgentPromptPath: resolveAgentPromptPath('cascade-inspect-discarded.md'),
      introducedAgentPromptPath: resolveAgentPromptPath('cascade-inspect-introduced.md'),
      concurrency: 2,
      dispatch: async ({ input }) => {
        dispatchCalls.push(input);
        return cannedVerdict(input);
      },
      progress: (phase, e) => {
        progressEvents.push({ phase, kind: e.kind, index: e.index });
        // Silent under test — we only verify the events were fired.
      },
    });

    expect(result.introduced.length).toBe(analyzer.introducedGroups.length);
    expect(result.discarded.length).toBe(analyzer.discardedGroups.length);
    expect(dispatchCalls.length).toBe(
      analyzer.introducedGroups.length + analyzer.discardedGroups.length,
    );

    // Every dispatched input was introduced-kind here (no discarded fixture),
    // and progress fired start+end for each.
    const starts = progressEvents.filter((e) => e.phase === 'start');
    const ends = progressEvents.filter((e) => e.phase === 'end');
    expect(starts.length).toBe(dispatchCalls.length);
    expect(ends.length).toBe(dispatchCalls.length);
  });

  it('throws if agent prompt path is missing', async () => {
    const repo = makeRepo();
    seedCascadeRegistry(repo.root);
    repo.write('README.md', 'base\n');
    repo.commit('base');
    const analyzer = analyzeIntake({
      repoRoot: repo.root,
      target: 'main',
      source: 'main',
    });
    await expect(
      runInspect({
        analyzerJson: JSON.stringify(analyzer),
        repoRoot: repo.root,
        discardedAgentPromptPath: '/does/not/exist.md',
        introducedAgentPromptPath: resolveAgentPromptPath('cascade-inspect-introduced.md'),
      }),
    ).rejects.toThrow(/agent prompt not found/);
  });
});

function resolveAgentPromptPath(name: string): string {
  // tests run from cascade/, agent prompts live at ../.claude/agents/.
  const p = path.resolve(process.cwd(), '..', '.claude', 'agents', name);
  // Touch the file to assert it exists; throw a readable error if not.
  readFileSync(p);
  return p;
}

// silence unused-import warning for assembleDiscardedInput in some test runs
void assembleDiscardedInput;
