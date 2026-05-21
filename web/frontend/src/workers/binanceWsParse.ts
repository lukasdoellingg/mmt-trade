/**
 * Allocation-free Binance fstream JSON field extraction for worker hot paths.
 * Avoids JSON.parse on every kline / aggTrade / forceOrder tick.
 */

function skipWs(raw: string, i: number): number {
  while (i < raw.length && raw.charCodeAt(i) === 32) i++;
  return i;
}

function numField(raw: string, key: string, from = 0): number {
  const needle = `"${key}":`;
  let i = raw.indexOf(needle, from);
  if (i < 0) return 0;
  i = skipWs(raw, i + needle.length);
  const q = raw.charCodeAt(i);
  if (q === 34) {
    i++;
    let end = i;
    while (end < raw.length && raw.charCodeAt(end) !== 34) end++;
    return +raw.slice(i, end);
  }
  let end = i;
  while (end < raw.length) {
    const ch = raw.charCodeAt(end);
    if (ch === 44 || ch === 125 || ch === 93) break;
    end++;
  }
  return +raw.slice(i, end);
}

function boolField(raw: string, key: string, from = 0): boolean {
  const needle = `"${key}":`;
  let i = raw.indexOf(needle, from);
  if (i < 0) return false;
  i = skipWs(raw, i + needle.length);
  return raw.charCodeAt(i) === 116;
}

export interface BinanceKlineFields {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  x: boolean;
}

/** Combined-stream or raw kline object string. */
export function parseBinanceKline(raw: string): BinanceKlineFields | null {
  const kIdx = raw.indexOf('"k":{');
  if (kIdx < 0) return null;
  const seg = raw.slice(kIdx);
  const t = numField(seg, 't');
  if (!t) return null;
  return {
    t,
    o: numField(seg, 'o'),
    h: numField(seg, 'h'),
    l: numField(seg, 'l'),
    c: numField(seg, 'c'),
    v: numField(seg, 'v'),
    x: boolField(seg, 'x'),
  };
}

export interface BinanceForceOrderFields {
  T: number;
  E: number;
  p: number;
  q: number;
  sideSell: boolean;
}

export function parseBinanceForceOrder(raw: string): BinanceForceOrderFields | null {
  const oIdx = raw.indexOf('"o":{');
  if (oIdx < 0) return null;
  const seg = raw.slice(oIdx);
  const p = numField(seg, 'p');
  if (!p) return null;
  const sideNeedle = '"S":"';
  let si = seg.indexOf(sideNeedle);
  if (si < 0) return null;
  si += sideNeedle.length;
  const sideSell = seg.charCodeAt(si) === 83;
  return {
    T: numField(seg, 'T'),
    E: numField(raw, 'E'),
    p,
    q: numField(seg, 'q'),
    sideSell,
  };
}

export interface BinanceAggTradeFields {
  ts: number;
  price: number;
  qty: number;
  isSell: boolean;
}

export function parseBinanceAggTrade(raw: string): BinanceAggTradeFields | null {
  if (raw.indexOf('"aggTrade"') < 0) return null;
  const price = numField(raw, 'p');
  if (!price) return null;
  const ts = numField(raw, 'T') || numField(raw, 'E');
  return {
    ts,
    price,
    qty: numField(raw, 'q'),
    isSell: boolField(raw, 'm'),
  };
}
