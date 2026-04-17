import { describe, expect, it, beforeAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BranchClass,
  classOf,
  isEphemeral,
  isLongLived,
  loadRegistry,
  parentOf,
  versionSourceOf,
} from '../scripts/branch-graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

let registry: BranchClass[];
beforeAll(() => {
  registry = loadRegistry(repoRoot);
});

describe('classOf', () => {
  const cases: { branch: string; cls: string }[] = [
    { branch: 'main', cls: 'core' },
    { branch: 'core', cls: 'core' },
    { branch: 'upstream/main', cls: 'upstream' },
    { branch: 'upstream/skill/reactions', cls: 'upstream' },
    { branch: 'module/cascade', cls: 'module' },
    { branch: 'module/crypto', cls: 'module' },
    { branch: 'channel/telegram', cls: 'channel' },
    { branch: 'skill/reactions', cls: 'skill' },
    { branch: 'skill/reactions/whatsapp', cls: 'skill-adapter' },
    { branch: 'module/crypto/slack', cls: 'module-adapter' },
    { branch: 'edition/starter', cls: 'edition' },
    { branch: 'deploy/prod-acme', cls: 'deploy' },
    { branch: 'feature/foo', cls: 'ephemeral' },
    { branch: 'fix-typo', cls: 'ephemeral' },
  ];
  it.each(cases)('classifies $branch as $cls', ({ branch, cls }) => {
    expect(classOf(branch, registry).class.name).toBe(cls);
  });
});

describe('isLongLived / isEphemeral', () => {
  it('core is long-lived, not ephemeral', () => {
    const info = classOf('main', registry);
    expect(isLongLived(info)).toBe(true);
    expect(isEphemeral(info)).toBe(false);
  });
  it('ephemeral fallback', () => {
    const info = classOf('feature/foo', registry);
    expect(isLongLived(info)).toBe(false);
    expect(isEphemeral(info)).toBe(true);
  });
  it('upstream is read-only → not long-lived', () => {
    const info = classOf('upstream/main', registry);
    expect(isLongLived(info)).toBe(false);
    expect(info.class.read_only).toBe(true);
  });
});

describe('parentOf', () => {
  it('core → upstream/main', () => {
    expect(parentOf('main', registry, repoRoot)).toBe('upstream/main');
  });
  it('module → core', () => {
    expect(parentOf('module/cascade', registry, repoRoot)).toBe('core');
  });
  it('skill-adapter → parent skill', () => {
    expect(parentOf('skill/reactions/whatsapp', registry, repoRoot)).toBe('skill/reactions');
  });
  it('module-adapter → parent module', () => {
    expect(parentOf('module/crypto/telegram', registry, repoRoot)).toBe('module/crypto');
  });
  it('edition → core', () => {
    expect(parentOf('edition/starter', registry, repoRoot)).toBe('core');
  });
  it('ephemeral throws (deferred in Phase 0)', () => {
    expect(() => parentOf('feature/foo', registry, repoRoot)).toThrow(/ephemeral/i);
  });
  it('upstream throws (read-only)', () => {
    expect(() => parentOf('upstream/main', registry, repoRoot)).toThrow(/read-only/i);
  });
});

describe('versionSourceOf', () => {
  it('core → upstream/main', () => {
    expect(versionSourceOf('main', registry, repoRoot)).toBe('upstream/main');
  });
  it('module → core', () => {
    expect(versionSourceOf('module/cascade', registry, repoRoot)).toBe('core');
  });
  it('skill-adapter → parent skill', () => {
    expect(versionSourceOf('skill/reactions/whatsapp', registry, repoRoot)).toBe('skill/reactions');
  });
  it('ephemeral throws (not versioned)', () => {
    expect(() => versionSourceOf('feature/foo', registry, repoRoot)).toThrow(/not applicable/i);
  });
  it('upstream throws (read-only)', () => {
    expect(() => versionSourceOf('upstream/main', registry, repoRoot)).toThrow(/read-only/i);
  });
  it('edition with no parent_branch throws', () => {
    // No edition/* branch actually exists; versionSourceOf reads the file via
    // git-show on the branch, which fails with no ref → "missing".
    expect(() => versionSourceOf('edition/starter', registry, repoRoot)).toThrow(/parent_branch/);
  });
});
