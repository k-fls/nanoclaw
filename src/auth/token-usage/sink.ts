/**
 * Usage accounting sink — abstracts over where per-group token-usage events
 * are recorded. Per-provider parsers emit one UsageEvent per request through
 * a process-wide sink singleton. The default sink logs; another skill can
 * swap in a persistent implementation (e.g. SQLite) via setUsageSink().
 */
import type { GroupScope } from '../oauth-types.js';
import { logger } from '../../logger.js';

export interface UsageEvent {
  scope: GroupScope;
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  streaming: boolean;
  aborted: boolean;
}

export interface UsageSink {
  record(event: UsageEvent): void;
}

export class LogUsageSink implements UsageSink {
  record(event: UsageEvent): void {
    logger.info({ usage: event }, 'Token usage');
  }
}

let _sink: UsageSink = new LogUsageSink();

export function setUsageSink(sink: UsageSink): void {
  _sink = sink;
}

export function getUsageSink(): UsageSink {
  return _sink;
}
