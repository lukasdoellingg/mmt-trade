/**
 * Binary runtime plot decode (session envelope payload) + JSON fallback.
 */
import { parseScriptRuntimePayload, plotLinesToPrices } from './parseScriptRuntimePayload';

export const RUNTIME_PLOT_VERSION = 1;
export const RUNTIME_PLOT_VERSION_ROLES = 2;
export const MAX_RUNTIME_PLOT_PRICES = 64;

const plotPriceScratch = new Float64Array(MAX_RUNTIME_PLOT_PRICES);
const plotIdDecoder = new TextDecoder();

export type RuntimePlotParsed = {
  runtimeId: string;
  count: number;
  /** Parallel u8 role tags when payload version is 2. */
  roles?: Uint8Array;
};

/**
 * Parse binary plot payload into outPrices (zero alloc when binary).
 * Falls back to JSON envelope for legacy servers.
 */
export function parseRuntimePlotPayload(
  payload: ArrayBuffer,
  streamKey: string | undefined,
  outPrices: Float64Array,
  max: number,
): RuntimePlotParsed | null {
  const view = new DataView(payload);
  const ver = view.getUint8(0);
  if (payload.byteLength >= 5 && (ver === RUNTIME_PLOT_VERSION || ver === RUNTIME_PLOT_VERSION_ROLES)) {
    const idLen = view.getUint16(1, false);
    let o = 3 + idLen;
    if (payload.byteLength < o + 2) return null;
    const count = Math.min(view.getUint16(o, false), max);
    o += 2;
    if (payload.byteLength < o + count * 8) return null;
    const runtimeId = plotIdDecoder.decode(new Uint8Array(payload, 3, idLen));
    for (let i = 0; i < count; i++) {
      outPrices[i] = view.getFloat64(o, false);
      o += 8;
    }
    let roles: Uint8Array | undefined;
    if (ver === RUNTIME_PLOT_VERSION_ROLES && payload.byteLength >= o + count) {
      roles = new Uint8Array(count);
      for (let i = 0; i < count; i++) roles[i] = view.getUint8(o + i);
    }
    return { runtimeId, count, roles };
  }

  const text = plotIdDecoder.decode(new Uint8Array(payload));
  const parsed = parseScriptRuntimePayload(text, streamKey);
  if (!parsed) return null;
  const runtimeId =
    parsed.runtimeId ??
    (streamKey?.startsWith('runtime:') ? streamKey.slice('runtime:'.length) : '');
  const count = plotLinesToPrices(parsed.lines, outPrices, max);
  if (count <= 0 && !runtimeId) return null;
  return { runtimeId, count };
}

/** Minimal JSON for terminal shell Odin bridge. */
export function runtimePlotToJson(runtimeId: string, prices: Float64Array, count: number): string {
  let body = `{"data":{"runtime_id":"${runtimeId}","levels":[`;
  for (let i = 0; i < count; i++) {
    if (i > 0) body += ',';
    body += `{"price":${prices[i]}}`;
  }
  body += ']}}';
  return body;
}
