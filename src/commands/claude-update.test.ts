import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock updater module
const mockInstalledVersion = vi.fn(() => '2.1.74');
const mockGetActiveSetting = vi.fn(() => '24h');
const mockReconfigure = vi.fn();
const mockRunUpdate = vi.fn(async () => true);

vi.mock('../claude-updater/updater.js', () => ({
  installedVersion: () => mockInstalledVersion(),
  getActiveSetting: () => mockGetActiveSetting(),
  reconfigure: (s: string) => mockReconfigure(s),
  runUpdate: () => mockRunUpdate(),
}));

vi.mock('../remote-control.js', () => ({
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));

import { handleCommand } from './index.js';
import type { ChatIO } from '../interaction/types.js';
import type { RegisteredGroup } from '../types.js';

const mainGroup: RegisteredGroup = {
  name: 'main',
  folder: 'main',
  trigger: '',
  added_at: '',
  isMain: true,
};

const otherGroup: RegisteredGroup = {
  name: 'other',
  folder: 'other',
  trigger: '',
  added_at: '',
};

function ctx(group: RegisteredGroup = mainGroup) {
  return {
    containerName: null,
    group,
    chatJid: 'test@g.us',
    sender: 'user@s.whatsapp.net',
  };
}

function mockIO(): ChatIO {
  return {
    send: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
    sendRaw: vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    receive: vi
      .fn<(timeoutMs?: number) => Promise<string | null>>()
      .mockResolvedValue(null),
    hideMessage: vi.fn(),
    advanceCursor: vi.fn(),
  };
}

async function runAsync(result: {
  asyncAction?: (io: ChatIO) => Promise<void>;
}): Promise<string[]> {
  if (!result.asyncAction) return [];
  const io = mockIO();
  await result.asyncAction(io);
  return (io.send as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => c[0] as string,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInstalledVersion.mockReturnValue('2.1.74');
  mockGetActiveSetting.mockReturnValue('24h');
  mockRunUpdate.mockResolvedValue(true);
});

describe('/claude-version', () => {
  it('rejects non-main groups', async () => {
    const result = handleCommand('claude-version', '', ctx(otherGroup));
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('only available in the main group');
  });

  it('shows status with no args', async () => {
    const result = handleCommand('claude-version', '', ctx());
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('2.1.74');
    expect(msgs[0]).toContain('24h');
  });

  it('shows "not installed" when no version', async () => {
    mockInstalledVersion.mockReturnValue(null as unknown as string);
    const result = handleCommand('claude-version', '', ctx());
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('not installed');
  });

  it('update — triggers update (same as now)', async () => {
    const result = handleCommand('claude-version', 'update', ctx());
    const msgs = await runAsync(result);
    expect(mockRunUpdate).toHaveBeenCalled();
    expect(msgs[1]).toContain('Update complete');
  });

  it('update now — triggers update', async () => {
    const result = handleCommand('claude-version', 'update now', ctx());
    const msgs = await runAsync(result);
    expect(mockRunUpdate).toHaveBeenCalled();
    expect(msgs[1]).toContain('Update complete');
  });

  it('update now — rejects when no setting', async () => {
    mockGetActiveSetting.mockReturnValue('');
    const result = handleCommand('claude-version', 'update now', ctx());
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('No update setting configured');
    expect(mockRunUpdate).not.toHaveBeenCalled();
  });

  it('update now — reports failure', async () => {
    mockRunUpdate.mockResolvedValue(false);
    const result = handleCommand('claude-version', 'update now', ctx());
    const msgs = await runAsync(result);
    expect(msgs[1]).toContain('failed');
  });

  it('update every 12h — sets periodic', async () => {
    const result = handleCommand('claude-version', 'update every 12h', ctx());
    const msgs = await runAsync(result);
    expect(mockReconfigure).toHaveBeenCalledWith('12h');
    expect(msgs[0]).toContain('12h');
  });

  it('update 24h — sets periodic (every is optional)', async () => {
    const result = handleCommand('claude-version', 'update 24h', ctx());
    const msgs = await runAsync(result);
    expect(mockReconfigure).toHaveBeenCalledWith('24h');
  });

  it('update rejects invalid period', async () => {
    const result = handleCommand('claude-version', 'update garbage', ctx());
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('Invalid period');
    expect(mockReconfigure).not.toHaveBeenCalled();
  });

  it('set 2.1.92 — pins version and installs', async () => {
    const result = handleCommand('claude-version', 'set 2.1.92', ctx());
    const msgs = await runAsync(result);
    expect(mockReconfigure).toHaveBeenCalledWith('2.1.92');
    expect(mockRunUpdate).toHaveBeenCalled();
    expect(msgs[1]).toContain('Installed');
  });

  it('set rejects non-version', async () => {
    const result = handleCommand('claude-version', 'set 24h', ctx());
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('Invalid version');
    expect(mockReconfigure).not.toHaveBeenCalled();
  });

  it('rejects unknown subcommand', async () => {
    const result = handleCommand('claude-version', 'foo', ctx());
    const msgs = await runAsync(result);
    expect(msgs[0]).toContain('Usage');
  });
});
