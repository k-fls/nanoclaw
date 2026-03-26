import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PendingAuthErrors } from './pending-auth-errors.js';
import type { ChatIO, CredentialProvider } from './types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./reauth.js', () => ({
  runReauth: vi.fn(async () => true),
}));

vi.mock('./provision.js', () => ({
  resolveScope: vi.fn((group: any) => group.folder),
}));

const { runReauth } = await import('./reauth.js');
const { createAuthGuard } = await import('./guard.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChat(): ChatIO & { sent: string[]; replies: string[] } {
  const chat = {
    sent: [] as string[],
    replies: [] as string[],
    async send(text: string) { chat.sent.push(text); },
    async sendRaw(text: string) { chat.sent.push(text); },
    async receive(_timeoutMs?: number): Promise<string | null> {
      return chat.replies.shift() ?? null;
    },
    advanceCursor: vi.fn(),
  };
  return chat;
}

function mockProvider(overrides: Partial<CredentialProvider> = {}): CredentialProvider {
  return {
    service: 'claude',
    displayName: 'Claude',
    hasValidCredentials: vi.fn(() => true),
    provision: vi.fn(() => ({ env: { ANTHROPIC_API_KEY: 'sk-test' } })),
    storeResult: vi.fn(),
    authOptions: vi.fn(() => []),
    ...overrides,
  };
}

const group = { name: 'test-group', folder: 'test-group', trigger: '', added_at: '' };

/** Build a realistic auth error string that matches the strict API_ERROR_RE regex. */
function authError(requestId = 'req_abc'): string {
  return `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"${requestId}"}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuthGuard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('preCheck', () => {
    it('returns true when credentials are available', async () => {
      const provider = mockProvider();
      const guard = createAuthGuard(group, mockChat, vi.fn(), provider);

      expect(await guard.preCheck()).toBe(true);
      expect(runReauth).not.toHaveBeenCalled();
    });

    it('goes straight to reauth when no credentials (no refresh attempt)', async () => {
      const provider = mockProvider({
        hasValidCredentials: vi.fn(() => false),
        refresh: vi.fn(async () => true),
      });
      const guard = createAuthGuard(group, () => mockChat(), vi.fn(), provider);

      await guard.preCheck();

      // refresh should NOT be called — guard goes straight to reauth
      expect(provider.refresh).not.toHaveBeenCalled();
      expect(runReauth).toHaveBeenCalled();
    });
  });

  describe('onStreamResult', () => {
    it('detects auth error and calls closeStdin', () => {
      const closeStdin = vi.fn();
      const guard = createAuthGuard(group, mockChat, closeStdin, mockProvider());

      guard.onStreamResult({ status: 'error', error: authError() });

      expect(closeStdin).toHaveBeenCalled();
    });

    it('uses proxy-confirmed detection when pendingErrors provided', () => {
      const closeStdin = vi.fn();
      const pending = new PendingAuthErrors();
      pending.record('req_abc');
      const guard = createAuthGuard(group, mockChat, closeStdin, mockProvider(), pending);

      guard.onStreamResult({ status: 'error', error: authError() });

      expect(closeStdin).toHaveBeenCalled();
    });

    it('ignores non-auth errors', () => {
      const closeStdin = vi.fn();
      const guard = createAuthGuard(group, mockChat, closeStdin, mockProvider());

      guard.onStreamResult({ status: 'error', error: 'some random error' });

      expect(closeStdin).not.toHaveBeenCalled();
    });
  });

  describe('handleAuthError', () => {
    it('returns not-auth when no auth error detected', async () => {
      const guard = createAuthGuard(group, () => mockChat(), vi.fn(), mockProvider());

      expect(await guard.handleAuthError('some non-auth error')).toBe('not-auth');
    });

    it('does not attempt container-based refresh', async () => {
      const provider = mockProvider({
        provision: vi.fn()
          .mockReturnValueOnce({ env: { KEY: 'val' } })  // preCheck
          .mockReturnValue({ env: {} }),                   // handleAuthError checks
        refresh: vi.fn(async () => true),
      });
      const guard = createAuthGuard(group, () => mockChat(), vi.fn(), provider);

      guard.onStreamResult({ status: 'error', error: authError() });

      await guard.handleAuthError();

      // refresh should NOT be called — goes straight to reauth
      expect(provider.refresh).not.toHaveBeenCalled();
      expect(runReauth).toHaveBeenCalled();
    });

    it('goes straight to reauth on auth error', async () => {
      const provider = mockProvider({
        provision: vi.fn()
          .mockReturnValueOnce({ env: { KEY: 'val' } })
          .mockReturnValue({ env: {} }),
      });
      const guard = createAuthGuard(
        group, () => mockChat(), vi.fn(), provider,
      );

      guard.onStreamResult({ status: 'error', error: authError() });

      const result = await guard.handleAuthError();

      expect(result).not.toBe('not-auth');
      expect(runReauth).toHaveBeenCalled();
    });

    it('clears pendingErrors on auth error', async () => {
      const pending = new PendingAuthErrors();
      pending.record('req_abc');
      pending.record('req_2');

      const provider = mockProvider({
        provision: vi.fn()
          .mockReturnValueOnce({ env: { KEY: 'val' } })
          .mockReturnValue({ env: {} }),
      });
      const guard = createAuthGuard(
        group, () => mockChat(), vi.fn(), provider, pending,
      );

      guard.onStreamResult({
        status: 'error',
        error: authError(), // uses req_abc which is in pending
      });

      await guard.handleAuthError();

      expect(pending.size).toBe(0);
    });
  });
});
