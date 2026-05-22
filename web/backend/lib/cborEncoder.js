/**
 * CBOR encoder helpers for the mmt.gg-compatible /api/v2/ws server frames.
 *
 * Envelope shape (matches `docs/MMT_PROTOCOL.md`):
 *   {
 *     0: <method/event name>,    // e.g. "frame", "subscribed", "error", "pong"
 *     2: <stream id>,            // integer from streamRegistry
 *     3: <pair>,                 // { exchange, symbol }
 *     4: <ts seconds>,           // numeric
 *     5: <payload>,              // stream-specific (column / candle / trade list)
 *     6: <bucket_group>,         // integer when applicable
 *   }
 *
 * Numeric keys mirror mmt.gg's tag layout so the wire bytes are identical
 * when the backend proxies upstream frames untouched.
 */

import cbor from 'cbor';

const SERIALIZER = new cbor.Encoder({ canonical: true });

/** Encode an envelope to a Buffer for `socket.send`. */
export function encodeEnvelope(envelope) {
  return cbor.encode(envelope);
}

/** Encode a stream frame: stream + pair + ts + payload + bucket_group. */
export function encodeStreamFrame({ stream, pair, ts, data, bucket_group = 0 }) {
  const envelope = {
    0: 'frame',
    2: stream,
    3: pair,
    4: ts,
    5: data,
  };
  if (bucket_group) envelope[6] = bucket_group;
  return cbor.encode(envelope);
}

/** Encode a response control frame (subscribed/unsubscribed/error/pong). */
export function encodeControlFrame(method, payload = {}) {
  return cbor.encode({ 0: method, ...payload });
}

/** Server config response — minimal but well-formed. */
export function encodeServerConfig(version = 'mmt-trade-1.0.0') {
  return cbor.encode({
    0: 'serverconfig',
    1: { version, exchanges: ['binance', 'binancef', 'bybit', 'bybitf', 'coinbase', 'kraken', 'okx'] },
  });
}

export { SERIALIZER };
