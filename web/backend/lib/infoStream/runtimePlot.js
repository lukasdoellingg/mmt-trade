/**
 * Binary runtime plot payload — avoids JSON.parse on session hot path.
 * Layout: u8 version(1) | u16 runtimeIdLen | runtimeId utf8 | u16 priceCount | f64BE[] prices
 */
export const RUNTIME_PLOT_VERSION = 1;
/** prices + u8 role per level (key-levels tags). */
export const RUNTIME_PLOT_VERSION_ROLES = 2;
export const MAX_RUNTIME_PLOT_PRICES = 64;

/**
 * @param {string} runtimeId
 * @param {number[]} prices
 * @returns {Buffer}
 */
export function encodeRuntimePlotPayload(runtimeId, prices) {
  const idBytes = Buffer.from(runtimeId, 'utf8');
  const count = Math.min(prices?.length ?? 0, MAX_RUNTIME_PLOT_PRICES);
  const buf = Buffer.allocUnsafe(1 + 2 + idBytes.length + 2 + count * 8);
  let o = 0;
  buf.writeUInt8(RUNTIME_PLOT_VERSION, o);
  o += 1;
  buf.writeUInt16BE(idBytes.length, o);
  o += 2;
  idBytes.copy(buf, o);
  o += idBytes.length;
  buf.writeUInt16BE(count, o);
  o += 2;
  for (let i = 0; i < count; i++) {
    buf.writeDoubleBE(+prices[i], o);
    o += 8;
  }
  return buf;
}

/**
 * @param {string} runtimeId
 * @param {number[]} prices
 * @param {number[]} [roles] — parallel u8 roles (same length as prices)
 * @returns {Buffer}
 */
export function encodeRuntimePlotPayloadWithRoles(runtimeId, prices, roles) {
  const idBytes = Buffer.from(runtimeId, 'utf8');
  const count = Math.min(prices?.length ?? 0, MAX_RUNTIME_PLOT_PRICES);
  const buf = Buffer.allocUnsafe(1 + 2 + idBytes.length + 2 + count * 8 + count);
  let o = 0;
  buf.writeUInt8(RUNTIME_PLOT_VERSION_ROLES, o);
  o += 1;
  buf.writeUInt16BE(idBytes.length, o);
  o += 2;
  idBytes.copy(buf, o);
  o += idBytes.length;
  buf.writeUInt16BE(count, o);
  o += 2;
  for (let i = 0; i < count; i++) {
    buf.writeDoubleBE(+prices[i], o);
    o += 8;
  }
  for (let i = 0; i < count; i++) {
    buf.writeUInt8((roles?.[i] ?? 0) & 0xff, o);
    o += 1;
  }
  return buf;
}

/** @param {Buffer | Uint8Array} buf */
export function isRuntimePlotPayload(buf) {
  return buf && buf.length >= 5 && (buf[0] === RUNTIME_PLOT_VERSION || buf[0] === RUNTIME_PLOT_VERSION_ROLES);
}
