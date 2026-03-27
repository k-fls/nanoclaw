import { describe, it, expect, beforeEach } from 'vitest';
import http from 'http';

import { asGroupScope } from './oauth-types.js';
import {
  handleBrowserOpen,
  registerAuthorizationEndpoint,
  registerAuthorizationPattern,
  setBrowserOpenCallback,
  type BrowserOpenEvent,
} from './browser-open-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock IncomingMessage with a JSON body. */
function mockRequest(body: string): http.IncomingMessage {
  const { Readable } = require('stream');
  const req = new Readable() as http.IncomingMessage;
  req.push(body);
  req.push(null);
  return req;
}

/** Create a mock ServerResponse that captures the output. */
function mockResponse(): http.ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      res.headersSent = true;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  } as any;
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser-open-handler', () => {
  beforeEach(() => {
    setBrowserOpenCallback(null as any);
  });

  describe('handleBrowserOpen', () => {
    it('returns exit_code 0 for known OAuth URLs', async () => {
      registerAuthorizationEndpoint('https://accounts.google.com/o/oauth2/v2/auth', 'google');

      const req = mockRequest(JSON.stringify({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=foo' }));
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('test-scope'));

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.exit_code).toBe(0);
    });

    it('returns empty object (pass-through) for unknown URLs', async () => {
      const req = mockRequest(JSON.stringify({ url: 'https://docs.example.com/help' }));
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('test-scope'));

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.exit_code).toBeUndefined();
    });

    it('returns exit_code 1 for invalid JSON', async () => {
      const req = mockRequest('not json');
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('test-scope'));

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.exit_code).toBe(1);
    });

    it('returns exit_code 1 for missing url field', async () => {
      const req = mockRequest(JSON.stringify({ foo: 'bar' }));
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('test-scope'));

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.exit_code).toBe(1);
    });

    it('invokes callback with url and scope for known OAuth URLs', async () => {
      registerAuthorizationEndpoint('https://claude.ai/oauth/authorize', 'claude');

      const events: BrowserOpenEvent[] = [];
      setBrowserOpenCallback((e) => { events.push(e); return 'claude:12345'; });

      const req = mockRequest(JSON.stringify({ url: 'https://claude.ai/oauth/authorize?client_id=abc' }));
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('my-group'));

      expect(events).toHaveLength(1);
      expect(events[0].url).toBe('https://claude.ai/oauth/authorize?client_id=abc');
      expect(events[0].scope).toBe('my-group');
      expect(events[0].providerId).toBe('claude');

      // flowId should be in the response
      const body = JSON.parse(res._body);
      expect(body.flowId).toBe('claude:12345');
    });

    it('does not invoke callback for unknown URLs', async () => {
      const events: BrowserOpenEvent[] = [];
      setBrowserOpenCallback((e) => { events.push(e); return null; });

      const req = mockRequest(JSON.stringify({ url: 'https://example.com/page' }));
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('test-scope'));

      expect(events).toHaveLength(0);
    });

    it('matches patterns registered via registerAuthorizationPattern', async () => {
      registerAuthorizationPattern(/^https:\/\/custom\.idp\.com\/auth/, 'custom-idp');

      const req = mockRequest(JSON.stringify({ url: 'https://custom.idp.com/auth?state=xyz' }));
      const res = mockResponse();

      await handleBrowserOpen(req, res, asGroupScope('test-scope'));

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).exit_code).toBe(0);
    });
  });
});
