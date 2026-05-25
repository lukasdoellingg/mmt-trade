/**
 * Key Levels — swing pivots, previous-period H/L/C, classic pivot math, session range.
 * Output: sorted unique prices (newest / strongest first within limit).
 */

/** @typedef {{ price: number, role: number, strength: number }} KeyLevel */

export const KEY_LEVEL_ROLE = {
  PIVOT_HIGH: 1,
  PIVOT_LOW: 2,
  PREV_HIGH: 3,
  PREV_LOW: 4,
  PREV_CLOSE: 5,
  SESSION_HIGH: 6,
  SESSION_LOW: 7,
  PIVOT_R1: 8,
  PIVOT_S1: 9,
  PIVOT_R2: 10,
  PIVOT_S2: 11,
  ROUND: 12,
  LAST: 13,
  PIVOT_MID: 14,
};

const ROLE_STRENGTH = {
  [KEY_LEVEL_ROLE.PREV_HIGH]: 100,
  [KEY_LEVEL_ROLE.PREV_LOW]: 100,
  [KEY_LEVEL_ROLE.PREV_CLOSE]: 95,
  [KEY_LEVEL_ROLE.PIVOT_MID]: 88,
  [KEY_LEVEL_ROLE.PIVOT_R1]: 90,
  [KEY_LEVEL_ROLE.PIVOT_S1]: 90,
  [KEY_LEVEL_ROLE.PIVOT_R2]: 85,
  [KEY_LEVEL_ROLE.PIVOT_S2]: 85,
  [KEY_LEVEL_ROLE.SESSION_HIGH]: 80,
  [KEY_LEVEL_ROLE.SESSION_LOW]: 80,
  [KEY_LEVEL_ROLE.PIVOT_HIGH]: 70,
  [KEY_LEVEL_ROLE.PIVOT_LOW]: 70,
  [KEY_LEVEL_ROLE.ROUND]: 50,
  [KEY_LEVEL_ROLE.LAST]: 40,
};

function periodBarsForTf(tf) {
  const map = {
    '1m': 60,
    '5m': 48,
    '15m': 32,
    '30m': 24,
    '1h': 24,
    '4h': 12,
    '1D': 2,
    '1d': 2,
    '1W': 2,
    '1w': 2,
  };
  return map[tf] ?? 24;
}

function swingWindowForTf(tf) {
  const map = { '1m': 2, '5m': 2, '15m': 3, '30m': 3, '1h': 5, '4h': 5, '1D': 3, '1d': 3, '1W': 2, '1w': 2 };
  return map[tf] ?? 5;
}

function priceDecimals(ref) {
  if (ref >= 50_000) return 0;
  if (ref >= 1000) return 1;
  if (ref >= 10) return 2;
  return 4;
}

function roundPrice(p, ref) {
  const d = priceDecimals(ref);
  const m = 10 ** d;
  return Math.round(p * m) / m;
}

function pushLevel(out, price, role, ref) {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const p = roundPrice(price, ref);
  const strength = ROLE_STRENGTH[role] ?? 50;
  out.push({ price: p, role, strength });
}

function detectSwingPivots(klines, w, ref, out) {
  for (let i = w; i < klines.length - w; i++) {
    const hi = klines[i].high;
    const lo = klines[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= w; j++) {
      if (hi <= klines[i - j].high || hi <= klines[i + j].high) isHigh = false;
      if (lo >= klines[i - j].low || lo >= klines[i + j].low) isLow = false;
    }
    if (isHigh) pushLevel(out, hi, KEY_LEVEL_ROLE.PIVOT_HIGH, ref);
    if (isLow) pushLevel(out, lo, KEY_LEVEL_ROLE.PIVOT_LOW, ref);
  }
}

function classicPivots(h, l, c, ref, out) {
  if (!(h > 0 && l > 0 && c > 0) || h < l) return;
  const p = (h + l + c) / 3;
  pushLevel(out, p, KEY_LEVEL_ROLE.PIVOT_MID, ref);
  pushLevel(out, 2 * p - l, KEY_LEVEL_ROLE.PIVOT_R1, ref);
  pushLevel(out, 2 * p - h, KEY_LEVEL_ROLE.PIVOT_S1, ref);
  pushLevel(out, p + (h - l), KEY_LEVEL_ROLE.PIVOT_R2, ref);
  pushLevel(out, p - (h - l), KEY_LEVEL_ROLE.PIVOT_S2, ref);
}

function roundMagnets(ref, out, max = 6) {
  let step = 100;
  if (ref >= 50_000) step = 1000;
  else if (ref >= 10_000) step = 500;
  else if (ref >= 1000) step = 100;
  else if (ref >= 100) step = 10;
  else if (ref >= 10) step = 1;
  else step = 0.1;

  const base = Math.round(ref / step) * step;
  for (let k = -max; k <= max; k++) {
    const p = base + k * step;
    if (p > 0) pushLevel(out, p, KEY_LEVEL_ROLE.ROUND, ref);
  }
}

function clusterLevels(levels, ref, maxCount) {
  const pct = ref >= 10_000 ? 0.0008 : ref >= 1000 ? 0.0012 : 0.002;
  const minGap = Math.max(ref * pct, stepMin(ref) * 0.5);

  const sorted = [...levels].sort((a, b) => b.strength - a.strength || b.price - a.price);
  /** @type {KeyLevel[]} */
  const kept = [];

  for (const lv of sorted) {
    let merge = false;
    for (const k of kept) {
      if (Math.abs(k.price - lv.price) <= minGap) {
        if (lv.strength > k.strength) {
          k.price = lv.price;
          k.role = lv.role;
          k.strength = lv.strength;
        }
        merge = true;
        break;
      }
    }
    if (!merge) kept.push({ ...lv });
    if (kept.length >= maxCount * 2) break;
  }

  kept.sort((a, b) => a.price - b.price);
  return kept.slice(0, maxCount);
}

function stepMin(ref) {
  if (ref >= 50_000) return 1;
  if (ref >= 1000) return 0.1;
  return 0.01;
}

/**
 * @param {{ high: number, low: number, close: number }[]} klines
 * @param {string} [tf]
 * @param {number} [maxCount]
 * @returns {{ prices: number[], roles: number[] }}
 */
export function computeKeyLevelsDetailed(klines, tf = '1h', maxCount = 24) {
  if (!klines?.length) return { prices: [], roles: [] };

  const last = klines[klines.length - 1];
  const ref = last.close > 0 ? last.close : last.high;
  /** @type {KeyLevel[]} */
  const raw = [];

  const pb = Math.max(2, periodBarsForTf(tf));
  const prevStart = Math.max(0, klines.length - pb * 2);
  const prevEnd = Math.max(prevStart + 1, klines.length - pb);
  const prevSlice = klines.slice(prevStart, prevEnd);
  const recentSlice = klines.slice(Math.max(0, klines.length - pb));

  let pdh = 0;
  let pdl = Infinity;
  let pdc = last.close;
  for (const k of prevSlice) {
    if (k.high > pdh) pdh = k.high;
    if (k.low < pdl) pdl = k.low;
    pdc = k.close;
  }
  if (pdl === Infinity) pdl = last.low;

  pushLevel(raw, pdh, KEY_LEVEL_ROLE.PREV_HIGH, ref);
  pushLevel(raw, pdl, KEY_LEVEL_ROLE.PREV_LOW, ref);
  pushLevel(raw, pdc, KEY_LEVEL_ROLE.PREV_CLOSE, ref);
  classicPivots(pdh, pdl, pdc, ref, raw);

  let sh = 0;
  let sl = Infinity;
  for (const k of recentSlice) {
    if (k.high > sh) sh = k.high;
    if (k.low < sl) sl = k.low;
  }
  if (sl === Infinity) sl = last.low;
  pushLevel(raw, sh, KEY_LEVEL_ROLE.SESSION_HIGH, ref);
  pushLevel(raw, sl, KEY_LEVEL_ROLE.SESSION_LOW, ref);
  pushLevel(raw, last.close, KEY_LEVEL_ROLE.LAST, ref);

  detectSwingPivots(klines, swingWindowForTf(tf), ref, raw);
  roundMagnets(ref, raw, 4);

  const clustered = clusterLevels(raw, ref, maxCount);
  const prices = clustered.map((l) => l.price);
  const roles = clustered.map((l) => l.role);
  return { prices, roles };
}

/**
 * Legacy: prices only (roles dropped).
 * @param {{ high: number, low: number, close: number }[]} klines
 * @param {string} [tf]
 * @param {number} [maxCount]
 * @returns {number[]}
 */
export function computeKeyLevels(klines, tf = '1h', maxCount = 24) {
  return computeKeyLevelsDetailed(klines, tf, maxCount).prices;
}
