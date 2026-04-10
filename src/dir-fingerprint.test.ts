import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    ensureAgent = vi.fn().mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

import { dirFingerprint } from './container-runner.js';

describe('dirFingerprint', () => {
  let srcDir: string;
  let dstDir: string;

  beforeEach(() => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-src-'));
    dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-dst-'));
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(dstDir, { recursive: true, force: true });
  });

  function writeFingerprint(dir: string): void {
    fs.writeFileSync(path.join(dir, '.fingerprint'), dirFingerprint(dir));
  }

  function readFingerprint(dir: string): string {
    return fs.readFileSync(path.join(dir, '.fingerprint'), 'utf-8').trim();
  }

  function syncDirs(): void {
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }

  it('fingerprints match after cpSync', () => {
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello');
    fs.writeFileSync(path.join(srcDir, 'b.ts'), 'world');
    writeFingerprint(srcDir);
    syncDirs();
    expect(readFingerprint(srcDir)).toBe(readFingerprint(dstDir));
  });

  it('fingerprints diverge when source gets a new file', () => {
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello');
    writeFingerprint(srcDir);
    syncDirs();

    // Add a new file to source and re-fingerprint
    fs.writeFileSync(path.join(srcDir, 'b.ts'), 'new tool');
    writeFingerprint(srcDir);

    expect(readFingerprint(srcDir)).not.toBe(readFingerprint(dstDir));
  });

  it('fingerprints match again after re-sync', () => {
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello');
    writeFingerprint(srcDir);
    syncDirs();

    // Add file, re-fingerprint, re-sync
    fs.writeFileSync(path.join(srcDir, 'b.ts'), 'new tool');
    writeFingerprint(srcDir);
    syncDirs();

    expect(readFingerprint(srcDir)).toBe(readFingerprint(dstDir));
  });

  it('fingerprints diverge when source file is modified', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello');
    writeFingerprint(srcDir);
    syncDirs();

    // Ensure mtime advances
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'modified');
    writeFingerprint(srcDir);

    expect(readFingerprint(srcDir)).not.toBe(readFingerprint(dstDir));
  });

  it('ignores .fingerprint file itself in hash computation', () => {
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello');
    const h1 = dirFingerprint(srcDir);
    fs.writeFileSync(path.join(srcDir, '.fingerprint'), 'anything');
    const h2 = dirFingerprint(srcDir);
    expect(h1).toBe(h2);
  });

  it('ignores subdirectories', () => {
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'hello');
    const h1 = dirFingerprint(srcDir);
    fs.mkdirSync(path.join(srcDir, 'subdir'));
    const h2 = dirFingerprint(srcDir);
    expect(h1).toBe(h2);
  });
});
