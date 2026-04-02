/**
 * Shared test utilities.
 *
 * Uses vi.spyOn (not vi.mock) so the real logger is preserved — only the
 * specific test that opts in is silenced. Unexpected output from other tests
 * remains visible.
 */
import { vi } from 'vitest';
import { logger } from './logger.js';

/** Spy on logger methods so expected output doesn't hit stderr. */
export function muteLogger() {
  return {
    debug: vi.spyOn(logger, 'debug').mockImplementation((() => logger) as any),
    info: vi.spyOn(logger, 'info').mockImplementation((() => logger) as any),
    warn: vi.spyOn(logger, 'warn').mockImplementation((() => logger) as any),
    error: vi.spyOn(logger, 'error').mockImplementation((() => logger) as any),
  };
}

/** Restore all spies from muteLogger(). */
export function restoreLogger(spies: ReturnType<typeof muteLogger>) {
  Object.values(spies).forEach((s) => s.mockRestore());
}
