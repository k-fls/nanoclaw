# Proxy Tap: Body Capture

The tap logger (`src/proxy-tap-logger.ts`) observes raw HTTP bytes flowing through the MITM proxy and writes JSONL entries. Previously it captured only headers. Now it captures request and response bodies too.

## How it works

The tap receives raw socket bytes via `ProxyTapCallback` events — `inbound` (client request) and `outbound` (server response). Each direction is processed in two phases:

**Phase 1 — Header accumulation.** Chunks are buffered until `\r\n\r\n` (end of HTTP headers) is found. Headers are parsed and emitted as a JSONL entry. Any body bytes that arrived in the same chunk as the headers are extracted and moved to the body buffer.

**Phase 2 — Body accumulation.** Subsequent chunks are appended to the body buffer. When `content-length` bytes have been received, the body is emitted. If there's no `content-length` (e.g. chunked or connection-close framing), the body is flushed when the socket closes.

## Body encoding

Bodies are stored as **base64** in the JSONL. This preserves binary data (gzip, etc.) without corruption. Decode offline:

```python
import base64, gzip, json
raw = base64.b64decode(entry['body'])
if raw[:2] == b'\x1f\x8b':
    text = gzip.decompress(raw).decode('utf-8')
else:
    text = raw.decode('utf-8')
```

## Why base64, not UTF-8

The tap sees raw bytes from the socket. Response bodies may be gzip-compressed. Converting gzip bytes to a UTF-8 string replaces invalid bytes (e.g. `0x8b`) with U+FFFD replacement characters, destroying the data irreversibly. Base64 is a lossless byte-to-string encoding.

## Why latin1 for header parsing

HTTP headers are ASCII, but they share a buffer with the binary body. The header accumulation phase converts `Buffer` to string for parsing via `toString('latin1')`. Latin1 maps each byte 0x00–0xFF to the same code point — no replacement, no multi-byte expansion. This keeps byte offsets consistent between the string (used for `parseHead`) and the Buffer (used for body extraction).

Using `toString('utf-8')` here would corrupt body bytes that happen to arrive in the same chunk as the headers.

## Chunked transfer-encoding

When the response uses `transfer-encoding: chunked`, the raw body includes chunk framing (`hex-size\r\n...data...\r\n`). The `emitBody` function strips this framing before base64-encoding, so the logged body contains only the payload.

## Limits

- **64 KB cap** (`MAX_BODY_CAPTURE`). Bodies larger than this are truncated. No indicator in the output — the consumer must compare body size against `content-length` header.
- **One exchange per connection.** After the first request/response pair, subsequent exchanges on the same keep-alive connection are silently dropped. The tap tracks state per-direction and doesn't reset after a complete exchange.
- **Close-flushed bodies.** Without `content-length`, body emission depends on the socket `close` event. On keep-alive connections that stay open, the body may never be flushed.

## JSONL output format

Header entry (unchanged from before):
```json
{"ts":"...","scope":"...","host":"...","direction":"inbound","method":"POST","url":"/v1/oauth/token","headers":{...}}
```

Body entry (new):
```json
{"ts":"...","scope":"...","host":"...","direction":"inbound","type":"body","method":"POST","url":"/v1/oauth/token","body":"eyJncmFudF90eXBl..."}
```

The `type: "body"` field distinguishes body entries from header entries.
