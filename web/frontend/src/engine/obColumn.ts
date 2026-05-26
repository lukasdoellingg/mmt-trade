/** Bins order-book levels into one heatmap column (PRICE_ROWS × RG). */
import { PRICE_ROWS } from './ObHeatmapRenderer';

export const COLUMN_BYTES = PRICE_ROWS * 2;
export type BinMode = 'hd' | 'sd';
export const SD_MERGE_FACTOR = 4;

export function emptyColumn(): Uint8Array {
  return new Uint8Array(COLUMN_BYTES);
}

function volumeToByte(volume: number, lowCutoff: number): number {
  if (volume <= lowCutoff) return 0;
  return Math.min(255, (Math.log1p(volume - lowCutoff) * 52) | 0);
}

/** Keep hottest levels when backend sends MMT-scale depth */
export function subsampleLevels(
  levels: { price: number; volume: number; isBid: boolean }[],
  maxPerSide = 1200,
) {
  if (levels.length <= maxPerSide * 2) return levels;
  const bids = levels
    .filter((l) => l.isBid)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, maxPerSide);
  const asks = levels
    .filter((l) => !l.isBid)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, maxPerSide);
  return [...bids, ...asks];
}

/**
 * Bin order-book levels into `col`. When `accumulate` is false the column is
 * cleared first so each call produces a fresh snapshot of the current book —
 * within the call, multiple levels falling into the same price row still sum
 * into the same byte (clamped to 255). When `accumulate` is true the existing
 * column bytes are kept and added to — historical mode, used for snapshots.
 */
export function writeLevelsToColumn(
  col: Uint8Array,
  levels: { price: number; volume: number; isBid: boolean }[],
  minP: number,
  maxP: number,
  accumulate = true,
  lowCutoff = 0,
) {
  if (maxP <= minP) return;
  if (!accumulate) col.fill(0);
  const invRange = (PRICE_ROWS - 1) / (maxP - minP);
  for (let i = 0; i < levels.length; i++) {
    const L = levels[i];
    if (L.volume <= lowCutoff) continue;
    let row = ((maxP - L.price) * invRange + 0.5) | 0;
    if (row < 0) row = 0;
    if (row >= PRICE_ROWS) row = PRICE_ROWS - 1;
    const off = row * 2;
    const v = volumeToByte(L.volume, lowCutoff);
    if (v === 0) continue;
    if (L.isBid) {
      const cur = col[off + 1];
      col[off + 1] = cur + v > 255 ? 255 : cur + v;
    } else {
      const cur = col[off];
      col[off] = cur + v > 255 ? 255 : cur + v;
    }
  }
}

/** MMT SD: merge adjacent HD rows (max intensity per bucket). */
export function downsampleColumnHdToSd(src: Uint8Array): Uint8Array {
  const dst = emptyColumn();
  const f = SD_MERGE_FACTOR;
  const sdRows = Math.floor(PRICE_ROWS / f);
  for (let sr = 0; sr < sdRows; sr++) {
    let ask = 0;
    let bid = 0;
    for (let k = 0; k < f; k++) {
      const r = sr * f + k;
      if (r >= PRICE_ROWS) break;
      const off = r * 2;
      if (src[off] > ask) ask = src[off];
      if (src[off + 1] > bid) bid = src[off + 1];
    }
    for (let k = 0; k < f; k++) {
      const r = sr * f + k;
      if (r >= PRICE_ROWS) break;
      const off = r * 2;
      dst[off] = ask;
      dst[off + 1] = bid;
    }
  }
  return dst;
}

export function prepareColumnForDisplay(src: Uint8Array, mode: BinMode): Uint8Array {
  if (mode === 'hd') return src;
  return downsampleColumnHdToSd(src);
}

export function candleOpenTs(ts: number, tfMs: number): number {
  if (tfMs < 1000) return ts;
  return Math.floor(ts / tfMs) * tfMs;
}

/** lowSize 0..1 → volume cutoff from recent peak estimate */
export function lowCutoffVolume(lowNorm: number, refVolume: number): number {
  if (lowNorm <= 0 || refVolume <= 0) return 0;
  return refVolume * lowNorm * lowNorm;
}
