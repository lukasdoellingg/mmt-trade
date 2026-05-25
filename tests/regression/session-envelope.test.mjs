/**
 * Regression: session MUX binary envelope parser (frontend).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function parseSessionEnvelope(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 7) return null;
  if (view.getUint8(0) !== 1) return null;
  const keyLen = view.getUint16(1, false);
  const headerLen = 1 + 2 + keyLen + 4;
  if (view.byteLength < headerLen) return null;
  const key = new TextDecoder().decode(new Uint8Array(buf, 3, keyLen));
  const payloadLen = view.getUint32(3 + keyLen, false);
  if (headerLen + payloadLen > view.byteLength) return null;
  return {
    streamKey: key,
    payload: buf.slice(headerLen, headerLen + payloadLen),
  };
}

function encodeEnvelope(streamKey, payloadBytes) {
  const keyBytes = new TextEncoder().encode(streamKey);
  const header = new ArrayBuffer(1 + 2 + keyBytes.length + 4);
  const view = new DataView(header);
  let off = 0;
  view.setUint8(off, 1);
  off += 1;
  view.setUint16(off, keyBytes.length, false);
  off += 2;
  new Uint8Array(header, off, keyBytes.length).set(keyBytes);
  off += keyBytes.length;
  view.setUint32(off, payloadBytes.length, false);
  const out = new Uint8Array(header.byteLength + payloadBytes.length);
  out.set(new Uint8Array(header), 0);
  out.set(payloadBytes, header.byteLength);
  return out.buffer;
}

test('session envelope round-trip', () => {
  const key = 'binance:bybit:btc/usd:16:3600:0';
  const payload = new Uint8Array([1, 2, 3, 4]);
  const buf = encodeEnvelope(key, payload);
  const parsed = parseSessionEnvelope(buf);
  assert.ok(parsed);
  assert.equal(parsed.streamKey, key);
  assert.deepEqual(new Uint8Array(parsed.payload), payload);
});

test('session envelope rejects truncated buffer', () => {
  assert.equal(parseSessionEnvelope(new ArrayBuffer(4)), null);
});
