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

// Mock the token engine's hasAnyCredential method used by guard.start()
const mockHasAnyCredential = vi.fn(() => true);
vi.mock('./registry.js', () => ({
  getTokenEngine: vi.fn(() => ({
    hasAnyCredential: mockHasAnyCredential,
  })),
}));

// Mock consumeFlows — just resolve immediately
vi.mock('./flow-consumer.js', () => ({
  consumeFlows: vi.fn(async () => {}),
}));

// Shared pendingErrors so tests can record request IDs before triggering errors
const sharedPendingErrors = new PendingAuthErrors();

// Mock createSessionContext to avoid real PendingAuthErrors/FlowQueue wiring
vi.mock('./session-context.js', () => ({
  createSessionContext: vi.fn(() => ({
    scope: 'test-scope',
    pendingErrors: sharedPendingErrors,
    flowQueue: { onMutation: vi.fn() },
    statusRegistry: { destroy: vi.fn(), emit: vi.fn() },
    onAuthError: vi.fn(),
  })),
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
    async send(text: string) {
      chat.sent.push(text);
    },
    async sendRaw(text: string) {
      chat.sent.push(text);
    },
    async receive(_timeoutMs?: number): Promise<string | null> {
      return chat.replies.shift() ?? null;
    },
    hideMessage: vi.fn(),
    advanceCursor: vi.fn(),
  };
  return chat;
}

function mockProxy() {
  return {
    registerSessionContext: vi.fn(),
    deregisterSessionContext: vi.fn(),
    getSessionContext: vi.fn(),
  } as any;
}

function mockProvider(
  overrides: Partial<CredentialProvider> = {},
): CredentialProvider {
  return {
    id: 'claude',
    displayName: 'Claude',
    provision: vi.fn(() => ({ env: { ANTHROPIC_API_KEY: 'sk-test' } })),
    storeResult: vi.fn(),
    authOptions: vi.fn(() => []),
    ...overrides,
  };
}

const group = {
  name: 'test-group',
  folder: 'test-group',
  trigger: '',
  added_at: '',
};

/** Build a realistic auth error string that matches the strict API_ERROR_RE regex. */
function authError(requestId = 'req_abc'): string {
  return `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"${requestId}"}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedPendingErrors.clear();
  });

  describe('start', () => {
    it('returns true when credentials are available', async () => {
      mockHasAnyCredential.mockReturnValue(true);
      const guard = createAuthGuard(
        group,
        mockProxy(),
        mockChat,
        vi.fn(),
        mockProvider(),
      );

      expect(await guard.start()).toBe(true);
      expect(runReauth).not.toHaveBeenCalled();
    });

    it('goes straight to reauth when no credentials', async () => {
      mockHasAnyCredential.mockReturnValue(false);
      const guard = createAuthGuard(
        group,
        mockProxy(),
        () => mockChat(),
        vi.fn(),
        mockProvider(),
      );

      await guard.start();

      expect(runReauth).toHaveBeenCalled();
    });

    it('registers session context with proxy', async () => {
      mockHasAnyCredential.mockReturnValue(true);
      const proxy = mockProxy();
      const guard = createAuthGuard(
        group,
        proxy,
        mockChat,
        vi.fn(),
        mockProvider(),
      );

      await guard.start();

      expect(proxy.registerSessionContext).toHaveBeenCalled();
    });
  });

  describe('onStreamResult', () => {
    it('detects auth error and calls closeStdin', async () => {
      const closeStdin = vi.fn();
      const guard = createAuthGuard(
        group,
        mockProxy(),
        mockChat,
        closeStdin,
        mockProvider(),
      );
      await guard.start();

      // Simulate proxy recording the request ID (bearer-swap 401)
      sharedPendingErrors.record('req_abc');
      guard.onStreamResult({ status: 'error', error: authError() });

      expect(closeStdin).toHaveBeenCalled();
    });

    it('ignores non-auth errors', async () => {
      const closeStdin = vi.fn();
      const guard = createAuthGuard(
        group,
        mockProxy(),
        mockChat,
        closeStdin,
        mockProvider(),
      );
      await guard.start();

      guard.onStreamResult({ status: 'error', error: 'some random error' });

      expect(closeStdin).not.toHaveBeenCalled();
    });
  });

  describe('finish', () => {
    it('returns not-auth when no auth error detected', async () => {
      const guard = createAuthGuard(
        group,
        mockProxy(),
        () => mockChat(),
        vi.fn(),
        mockProvider(),
      );
      await guard.start();

      expect(await guard.finish('some non-auth error')).toBe('not-auth');
    });

    it('runs reauth on detected auth error', async () => {
      const guard = createAuthGuard(
        group,
        mockProxy(),
        () => mockChat(),
        vi.fn(),
        mockProvider(),
      );
      await guard.start();

      sharedPendingErrors.record('req_abc');
      guard.onStreamResult({ status: 'error', error: authError() });
      await guard.finish();

      expect(runReauth).toHaveBeenCalled();
    });

    it('returns reauth result on auth error', async () => {
      const guard = createAuthGuard(
        group,
        mockProxy(),
        () => mockChat(),
        vi.fn(),
        mockProvider(),
      );
      await guard.start();

      sharedPendingErrors.record('req_abc');
      guard.onStreamResult({ status: 'error', error: authError() });
      const result = await guard.finish();

      expect(result).not.toBe('not-auth');
      expect(runReauth).toHaveBeenCalled();
    });

    it('deregisters session context on finish', async () => {
      const proxy = mockProxy();
      const guard = createAuthGuard(
        group,
        proxy,
        () => mockChat(),
        vi.fn(),
        mockProvider(),
      );
      await guard.start();
      await guard.finish();

      expect(proxy.deregisterSessionContext).toHaveBeenCalled();
    });
  });
});
