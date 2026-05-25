// ═══════════════════════════════════════════════════════════════
//  orderbook_engine.wasm — Odin depth bar width fractions for DOM.
//  One WebAssembly.Instance per venue panel (isolated linear memory).
//  Build: powershell ./odin/orderbook/build_orderbook.ps1
// ═══════════════════════════════════════════════════════════════

const ROW_CAP = 1200;
const TARGET_PAGES = 8;
const F64_PER_PAIR = 2;

export const ORDERBOOK_ROW_CAP = ROW_CAP;

export type OrderbookWasmErrorCode =
  | 'FETCH_FAILED'
  | 'INSTANTIATE'
  | 'MISSING_EXPORT'
  | 'MEMORY_GROW'
  | 'LAYOUT'
  | 'ROW_CAP_MISMATCH'
  | 'SELFTEST';

export class OrderbookWasmError extends Error {
  readonly code: OrderbookWasmErrorCode;
  constructor(code: OrderbookWasmErrorCode, message: string) {
    super(message);
    this.name = 'OrderbookWasmError';
    this.code = code;
  }
}

interface WasmExports {
  memory: WebAssembly.Memory;
  fill_ask_width_fracs(n: number): void;
  fill_bid_width_fracs(n: number): void;
  get_ask_in_offset(): number;
  get_bid_in_offset(): number;
  get_ask_width_frac_offset(): number;
  get_bid_width_frac_offset(): number;
  get_row_cap(): number;
}

export interface OrderbookEngineBridge {
  memory: WebAssembly.Memory;
  exports: WasmExports;
  askInView: Float64Array;
  bidInView: Float64Array;
  askWidthView: Float32Array;
  bidWidthView: Float32Array;
  refreshViews(): void;
}

let wasmBytesCache: ArrayBuffer | null = null;

async function loadWasmBytes(): Promise<ArrayBuffer> {
  if (wasmBytesCache) return wasmBytesCache;
  const cacheBust = '?v=' + Date.now();
  const wasmUrl =
    typeof location !== 'undefined'
      ? new URL('/orderbook_engine.wasm' + cacheBust, location.origin).href
      : '/orderbook_engine.wasm' + cacheBust;
  let resp: Response;
  try {
    resp = await fetch(wasmUrl);
  } catch (e) {
    throw new OrderbookWasmError(
      'FETCH_FAILED',
      'orderbook_engine.wasm fetch failed: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
  if (!resp.ok) {
    throw new OrderbookWasmError(
      'FETCH_FAILED',
      `orderbook_engine.wasm HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  wasmBytesCache = await resp.arrayBuffer();
  return wasmBytesCache;
}

function readExports(instance: WebAssembly.Instance): WasmExports {
  const x = instance.exports as unknown as Partial<WasmExports>;
  const mem = x.memory;
  if (!mem || !(mem.buffer instanceof ArrayBuffer)) {
    throw new OrderbookWasmError('MISSING_EXPORT', 'WASM missing export "memory"');
  }
  for (const name of [
    'fill_ask_width_fracs',
    'fill_bid_width_fracs',
    'get_ask_in_offset',
    'get_bid_in_offset',
    'get_ask_width_frac_offset',
    'get_bid_width_frac_offset',
    'get_row_cap',
  ] as const) {
    if (typeof x[name] !== 'function') {
      throw new OrderbookWasmError('MISSING_EXPORT', `WASM missing export "${name}"`);
    }
  }
  return x as WasmExports;
}

function growMemory(mem: WebAssembly.Memory): void {
  const pages = mem.buffer.byteLength / 65536;
  if (pages >= TARGET_PAGES) return;
  const delta = TARGET_PAGES - pages;
  try {
    mem.grow(delta);
  } catch (e) {
    throw new OrderbookWasmError(
      'MEMORY_GROW',
      'WASM memory.grow failed: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
}

function assertLayout(mem: WebAssembly.Memory, exp: WasmExports): void {
  const askOff = exp.get_ask_in_offset();
  const bidOff = exp.get_bid_in_offset();
  const askW = exp.get_ask_width_frac_offset();
  const bidW = exp.get_bid_width_frac_offset();
  if (askOff % 8 !== 0 || bidOff % 8 !== 0 || askW % 4 !== 0 || bidW % 4 !== 0) {
    throw new OrderbookWasmError('LAYOUT', 'WASM buffer offsets are not suitably aligned');
  }
  const askBytes = ROW_CAP * F64_PER_PAIR * 8;
  const bidBytes = ROW_CAP * F64_PER_PAIR * 8;
  const wBytes = ROW_CAP * 4;
  const need = Math.max(askOff + askBytes, bidOff + bidBytes, askW + wBytes, bidW + wBytes);
  if (need > mem.buffer.byteLength) {
    throw new OrderbookWasmError(
      'LAYOUT',
      `WASM linear memory too small: need ${need} bytes, have ${mem.buffer.byteLength}`,
    );
  }
  if (bidOff < askOff + askBytes) {
    throw new OrderbookWasmError('LAYOUT', 'WASM BID_IN overlaps ASK_IN');
  }
}

function selfTest(bridge: OrderbookEngineBridge): void {
  const exp = bridge.exports;
  bridge.askInView[0] = 50_000;
  bridge.askInView[1] = 100;
  bridge.askInView[2] = 50_100;
  bridge.askInView[3] = 100;
  exp.fill_ask_width_fracs(2);
  bridge.refreshViews();
  const w0 = bridge.askWidthView[0];
  const w1 = bridge.askWidthView[1];
  if (!Number.isFinite(w0) || !Number.isFinite(w1)) {
    throw new OrderbookWasmError('SELFTEST', 'Non-finite width fracs');
  }
  if (Math.abs(w0 - w1) > 0.02) {
    throw new OrderbookWasmError('SELFTEST', `Equal qty should yield equal widths: ${w0} vs ${w1}`);
  }
  if (w0 < 0.85 || w0 > 0.96) {
    throw new OrderbookWasmError('SELFTEST', `Width frac out of range: ${w0}`);
  }
  bridge.askInView.fill(0);
  bridge.refreshViews();
}

export async function createOrderbookEngine(): Promise<OrderbookEngineBridge> {
  const bytes = await loadWasmBytes();
  let instance: WebAssembly.Instance;
  try {
    instance = (await WebAssembly.instantiate(bytes, {})).instance;
  } catch (e) {
    throw new OrderbookWasmError(
      'INSTANTIATE',
      'WebAssembly.instantiate failed: ' + (e instanceof Error ? e.message : String(e)),
    );
  }

  const exports = readExports(instance);
  const mem = exports.memory;
  growMemory(mem);

  const cap = exports.get_row_cap();
  if (cap !== ROW_CAP) {
    throw new OrderbookWasmError('ROW_CAP_MISMATCH', `WASM ROW_CAP ${cap} !== frontend ${ROW_CAP}`);
  }

  assertLayout(mem, exports);

  const askOff = exports.get_ask_in_offset();
  const bidOff = exports.get_bid_in_offset();
  const askWOff = exports.get_ask_width_frac_offset();
  const bidWOff = exports.get_bid_width_frac_offset();

  const bridge: OrderbookEngineBridge = {
    memory: mem,
    exports,
    askInView: new Float64Array(mem.buffer, askOff, ROW_CAP * 2),
    bidInView: new Float64Array(mem.buffer, bidOff, ROW_CAP * 2),
    askWidthView: new Float32Array(mem.buffer, askWOff, ROW_CAP),
    bidWidthView: new Float32Array(mem.buffer, bidWOff, ROW_CAP),
    refreshViews() {
      const b = mem.buffer;
      bridge.askInView = new Float64Array(b, askOff, ROW_CAP * 2);
      bridge.bidInView = new Float64Array(b, bidOff, ROW_CAP * 2);
      bridge.askWidthView = new Float32Array(b, askWOff, ROW_CAP);
      bridge.bidWidthView = new Float32Array(b, bidWOff, ROW_CAP);
    },
  };

  selfTest(bridge);
  return bridge;
}

export function packDepthPairs(rows: [number, number][], target: Float64Array): number {
  const n = Math.min(rows.length, ROW_CAP);
  for (let i = 0; i < n; i++) {
    target[i * 2] = +rows[i][0];
    target[i * 2 + 1] = +rows[i][1];
  }
  return n;
}

/** Pack asks and write ASK_W fracs (Odin). Returns row count. */
export function syncAskWidthFracs(eng: OrderbookEngineBridge, rows: [number, number][]): number {
  const n = packDepthPairs(rows, eng.askInView);
  eng.exports.fill_ask_width_fracs(n);
  eng.refreshViews();
  return n;
}

/** Pack bids and write BID_W fracs (Odin). Returns row count. */
export function syncBidWidthFracs(eng: OrderbookEngineBridge, rows: [number, number][]): number {
  const n = packDepthPairs(rows, eng.bidInView);
  eng.exports.fill_bid_width_fracs(n);
  eng.refreshViews();
  return n;
}
