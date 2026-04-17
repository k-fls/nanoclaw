import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage } from 'http';

import { captureClaudeUsage } from './anthropic.js';
import {
  setUsageSink,
  getUsageSink,
  type UsageEvent,
  type UsageSink,
} from './sink.js';
import { asGroupScope } from '../oauth-types.js';

class MemSink implements UsageSink {
  events: UsageEvent[] = [];
  record(e: UsageEvent): void {
    this.events.push(e);
  }
}

function makeCtx(
  method: string,
  url: string,
  contentType: string,
): {
  clientReq: IncomingMessage;
  upRes: IncomingMessage & { emitBody: (chunks: string[]) => void; emitClose: () => void };
} {
  const clientReq = { method, url, headers: {} } as unknown as IncomingMessage;

  const upResStream = new PassThrough();
  const upRes = upResStream as unknown as IncomingMessage & {
    emitBody: (chunks: string[]) => void;
    emitClose: () => void;
  };
  (upRes as unknown as { headers: Record<string, string> }).headers = {
    'content-type': contentType,
  };
  upRes.emitBody = (chunks: string[]) => {
    for (const c of chunks) upResStream.write(c);
    upResStream.end();
  };
  upRes.emitClose = () => {
    upResStream.emit('close');
  };
  return { clientReq, upRes };
}

const SCOPE = asGroupScope('grp');

let sink: MemSink;
let original: UsageSink;

beforeEach(() => {
  sink = new MemSink();
  original = getUsageSink();
  setUsageSink(sink);
});

afterEach(() => {
  setUsageSink(original);
});

describe('captureClaudeUsage — gating', () => {
  it('ignores GET /v1/messages', async () => {
    const { clientReq, upRes } = makeCtx(
      'GET',
      '/v1/messages',
      'text/event-stream',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody([
      'event: message_start\ndata: {"message":{"model":"x","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    await new Promise((r) => setImmediate(r));
    expect(sink.events).toHaveLength(0);
  });

  it('ignores POST /v1/messages/count_tokens', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages/count_tokens',
      'application/json',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody(['{"input_tokens":42}']);
    await new Promise((r) => setImmediate(r));
    expect(sink.events).toHaveLength(0);
  });

  it('ignores other POST paths', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/models',
      'application/json',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody(['{"data":[]}']);
    await new Promise((r) => setImmediate(r));
    expect(sink.events).toHaveLength(0);
  });

  it('ignores unexpected content-type on /v1/messages', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'text/html',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody(['<html></html>']);
    await new Promise((r) => setImmediate(r));
    expect(sink.events).toHaveLength(0);
  });
});

describe('captureClaudeUsage — streaming SSE', () => {
  it('captures input/output/cache tokens across message_start + message_delta', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'text/event-stream',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });

    upRes.emitBody([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"m","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    await new Promise((r) => setImmediate(r));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      scope: SCOPE,
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 42,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      streaming: true,
      aborted: false,
    });
  });

  it('handles chunks split mid-line', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'text/event-stream',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });

    const full =
      'event: message_start\ndata: {"message":{"model":"m","usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"usage":{"output_tokens":9}}\n\n' +
      'event: message_stop\ndata: {}\n\n';
    // Split every 13 bytes
    const parts: string[] = [];
    for (let i = 0; i < full.length; i += 13) parts.push(full.slice(i, i + 13));
    upRes.emitBody(parts);
    await new Promise((r) => setImmediate(r));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 9,
      model: 'm',
    });
  });

  it('flushes with aborted=true when stream closes before message_stop', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'text/event-stream',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });

    // Write some events then destroy without message_stop
    (upRes as unknown as PassThrough).write(
      'event: message_start\ndata: {"message":{"model":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
    );
    (upRes as unknown as PassThrough).write(
      'event: message_delta\ndata: {"usage":{"output_tokens":8}}\n\n',
    );
    (upRes as unknown as PassThrough).destroy();
    await new Promise((r) => setImmediate(r));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      aborted: true,
      outputTokens: 8,
      inputTokens: 3,
    });
  });

  it('emits exactly once even when message_stop + end both fire', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'text/event-stream',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody([
      'event: message_start\ndata: {"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    await new Promise((r) => setImmediate(r));
    expect(sink.events).toHaveLength(1);
  });
});

describe('captureClaudeUsage — non-stream JSON', () => {
  it('captures usage from single JSON response', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'application/json',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody([
      JSON.stringify({
        id: 'm',
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 55,
          output_tokens: 77,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 2,
        },
      }),
    ]);
    await new Promise((r) => setImmediate(r));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 55,
      outputTokens: 77,
      cacheReadTokens: 10,
      cacheCreationTokens: 2,
      streaming: false,
      aborted: false,
    });
  });

  it('does not emit when body is not valid JSON', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages',
      'application/json',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody(['not-json']);
    await new Promise((r) => setImmediate(r));
    // Nothing captured → nothing flushed (empty state is skipped)
    expect(sink.events).toHaveLength(0);
  });
});

describe('captureClaudeUsage — query strings', () => {
  it('matches /v1/messages?beta=1', async () => {
    const { clientReq, upRes } = makeCtx(
      'POST',
      '/v1/messages?beta=1',
      'text/event-stream',
    );
    captureClaudeUsage({ clientReq, upRes, scope: SCOPE });
    upRes.emitBody([
      'event: message_start\ndata: {"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    await new Promise((r) => setImmediate(r));
    expect(sink.events).toHaveLength(1);
  });
});
