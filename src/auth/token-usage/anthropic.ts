/**
 * Anthropic response parser for per-group token usage accounting.
 *
 * Attaches to the bearer-swap handler's `onUpstreamResponse` hook. Gates to
 * POST /v1/messages only — /v1/messages/count_tokens is a free pre-flight
 * (no inference, no usage) and is skipped.
 *
 * Streaming (text/event-stream): line-parses SSE, captures `model` + initial
 * usage from `message_start`, overwrites cumulative `output_tokens` from each
 * `message_delta` (Anthropic docs: "token counts in message_delta are
 * cumulative"), flushes on `message_stop` / stream end / close.
 *
 * Non-stream (application/json): buffers body, reads the single `usage`
 * object, flushes on end.
 *
 * The listener runs alongside the handler's `upRes.pipe(clientRes)` — Node
 * delivers each chunk to every `data` listener, so the tee adds zero bytes
 * of buffering to the client-facing path.
 */
import type { UpstreamResponseContext } from '../oauth-types.js';
import { getUsageSink } from './sink.js';

/** Matches /v1/messages exactly (with optional ?query), NOT /v1/messages/count_tokens. */
const MESSAGES_PATH = /^\/v1\/messages(?:\?.*)?$/;

export function captureClaudeUsage(ctx: UpstreamResponseContext): void {
  const method = ctx.clientReq.method || '';
  const url = ctx.clientReq.url || '';
  if (method !== 'POST' || !MESSAGES_PATH.test(url)) return;

  const contentType = String(
    ctx.upRes.headers['content-type'] || '',
  ).toLowerCase();
  const isStream = contentType.startsWith('text/event-stream');
  const isJson = contentType.startsWith('application/json');
  if (!isStream && !isJson) return;

  const state = {
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    flushed: false,
  };

  const flush = (aborted: boolean): void => {
    if (state.flushed) return;
    state.flushed = true;
    if (
      !state.model &&
      state.inputTokens === 0 &&
      state.outputTokens === 0
    ) {
      return;
    }
    getUsageSink().record({
      scope: ctx.scope,
      ts: Date.now(),
      model: state.model,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheCreationTokens: state.cacheCreationTokens,
      streaming: isStream,
      aborted,
    });
  };

  if (isStream) {
    attachSseParser(ctx, state, flush);
  } else {
    attachJsonParser(ctx, state, flush);
  }
}

type MutableState = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  flushed: boolean;
};

function attachSseParser(
  ctx: UpstreamResponseContext,
  state: MutableState,
  flush: (aborted: boolean) => void,
): void {
  let buf = '';
  let curEvent = '';

  ctx.upRes.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);

      if (line === '') {
        curEvent = '';
        continue;
      }
      if (line.startsWith('event: ')) {
        curEvent = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6);
      if (curEvent === 'message_start') {
        try {
          const obj = JSON.parse(data);
          const msg = obj.message || {};
          if (typeof msg.model === 'string') state.model = msg.model;
          applyUsage(state, msg.usage, true);
        } catch {
          /* ignore malformed event */
        }
      } else if (curEvent === 'message_delta') {
        try {
          const obj = JSON.parse(data);
          applyUsage(state, obj.usage, false);
        } catch {
          /* ignore */
        }
      } else if (curEvent === 'message_stop') {
        flush(false);
      }
    }
  });
  ctx.upRes.on('end', () => flush(false));
  ctx.upRes.on('close', () => flush(true));
  ctx.upRes.on('error', () => flush(true));
}

function attachJsonParser(
  ctx: UpstreamResponseContext,
  state: MutableState,
  flush: (aborted: boolean) => void,
): void {
  const chunks: Buffer[] = [];
  ctx.upRes.on('data', (c: Buffer) => chunks.push(c));
  ctx.upRes.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const obj = JSON.parse(body);
      if (typeof obj.model === 'string') state.model = obj.model;
      applyUsage(state, obj.usage, true);
      flush(false);
    } catch {
      flush(true);
    }
  });
  ctx.upRes.on('close', () => flush(true));
  ctx.upRes.on('error', () => flush(true));
}

/**
 * Apply Anthropic's `usage` object onto state.
 * `setInput` controls whether input_tokens overwrite (true for message_start /
 * non-stream response; false for message_delta which doesn't include input).
 */
function applyUsage(
  state: MutableState,
  u: unknown,
  setInput: boolean,
): void {
  if (!u || typeof u !== 'object') return;
  const usage = u as Record<string, unknown>;
  if (setInput && typeof usage.input_tokens === 'number') {
    state.inputTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    state.outputTokens = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    state.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    state.cacheCreationTokens = usage.cache_creation_input_tokens;
  }
}
