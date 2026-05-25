/** Binary session envelope: u8 version | u16 keyLen | key utf8 | u32 payloadLen | payload */

export const ENVELOPE_VERSION = 1;

export function encodeSessionEnvelope(streamKey, payload) {
  const keyBytes = Buffer.from(streamKey, 'utf8');
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.allocUnsafe(1 + 2 + keyBytes.length + 4);
  let offset = 0;
  header.writeUInt8(ENVELOPE_VERSION, offset);
  offset += 1;
  header.writeUInt16BE(keyBytes.length, offset);
  offset += 2;
  keyBytes.copy(header, offset);
  offset += keyBytes.length;
  header.writeUInt32BE(payloadBuf.length, offset);
  return Buffer.concat([header, payloadBuf]);
}
