/** Parse /ws/session binary envelope from backend multiplexer. */
export function parseSessionEnvelope(buf: ArrayBuffer): { streamKey: string; payload: ArrayBuffer } | null {
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

export function buildStreamKey(parts: {
  exchange: string;
  symbol: string;
  stream: number;
  timeframeSec: number;
  bucketGroup?: number;
}): string {
  const bg = parts.bucketGroup ?? 0;
  return `${parts.exchange}:${parts.symbol}:${parts.stream}:${parts.timeframeSec}:${bg}`;
}
