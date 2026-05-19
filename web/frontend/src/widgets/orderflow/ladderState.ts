/**
 * Zero-allocation aggregation state for an Order-Flow Ladder widget.
 *
 * Maintains a flat ring buffer of typed arrays keyed by price-bin index:
 *   - currentSize[bin]   — sum of |volume| at this bin in the current frame
 *   - lastSize[bin]      — same for the previous frame (delta is curr - last)
 *   - sideHint[bin]      — last seen isBid flag (>0.5 → bid)
 *
 * Bins are uniform: `binIndex = round((price - anchor) / pg)`. The anchor is
 * the mid price snapped to a PG-multiple so the ladder doesn't shift bins
 * as the mid drifts.
 */

import type { HeatmapLevel } from '../../engine/heatmapProto';

export interface LadderRow {
  /** Centre price of the bin in quote currency. */
  price: number;
  /** Total volume (base) at this bin in the latest frame. */
  size: number;
  /** Delta vs previous frame snapshot (positive = grew). */
  delta: number;
  /** Cumulative size from mid out to this row (always positive). */
  sum: number;
  /** True for bid bins, false for ask bins. */
  isBid: boolean;
}

export interface LadderSnapshot {
  midPrice: number;
  pg: number;
  asks: LadderRow[]; // descending price (closest to mid first → top of grid bottom-up; we render top-down so reverse)
  bids: LadderRow[]; // descending price
  maxSize: number;
  topAbsorption: number; // |Σ delta| in N rows nearest mid (used by the "+N price" tag)
  topAbsorptionPrice: number; // weighted mid of those rows
}

export interface LadderOptions {
  pg: number;
  rowsPerSide: number;
  topRowsForAbsorption: number;
}

export class LadderAggregator {
  private opts: LadderOptions;
  private currentSize: Float32Array;
  private lastSize: Float32Array;
  private isBidBin: Uint8Array;
  private anchor = 0;
  private capBins: number;

  constructor(opts: Partial<LadderOptions> = {}) {
    this.opts = { pg: 25, rowsPerSide: 25, topRowsForAbsorption: 4, ...opts };
    this.capBins = 2 * (this.opts.rowsPerSide + 32);
    this.currentSize = new Float32Array(this.capBins);
    this.lastSize = new Float32Array(this.capBins);
    this.isBidBin = new Uint8Array(this.capBins);
  }

  setPg(pg: number): void {
    if (pg === this.opts.pg) return;
    this.opts.pg = pg;
    this.lastSize.fill(0);
    this.currentSize.fill(0);
    this.isBidBin.fill(0);
  }

  setRowsPerSide(rows: number): void {
    if (rows === this.opts.rowsPerSide) return;
    this.opts.rowsPerSide = rows;
    const need = 2 * (rows + 32);
    if (need > this.capBins) {
      this.capBins = need;
      this.currentSize = new Float32Array(this.capBins);
      this.lastSize = new Float32Array(this.capBins);
      this.isBidBin = new Uint8Array(this.capBins);
    }
  }

  /** Ingest one HeatmapFrame.levels[] array. midPrice anchors the ladder. */
  ingest(levels: HeatmapLevel[], midPrice: number): void {
    const pg = this.opts.pg;
    if (pg <= 0 || midPrice <= 0) return;
    this.anchor = Math.round(midPrice / pg) * pg;

    // Rotate current → last, then zero current.
    this.lastSize.set(this.currentSize);
    this.currentSize.fill(0);
    this.isBidBin.fill(0);

    const half = this.capBins >>> 1;
    for (let i = 0; i < levels.length; i++) {
      const lv = levels[i];
      const off = Math.round((lv.price - this.anchor) / pg);
      const bin = half + off;
      if (bin < 0 || bin >= this.capBins) continue;
      const vol = Math.abs(lv.volume);
      this.currentSize[bin] += vol;
      if (lv.isBid) this.isBidBin[bin] = 1;
    }
  }

  /** Snapshot for rendering. Allocates only the LadderRow[] outputs. */
  snapshot(midPrice: number): LadderSnapshot {
    const { pg, rowsPerSide, topRowsForAbsorption } = this.opts;
    const half = this.capBins >>> 1;
    const asks: LadderRow[] = [];
    const bids: LadderRow[] = [];
    let maxSize = 0;
    let topAbs = 0;
    let topAbsW = 0;
    let topAbsWeight = 0;

    // Asks: bins above mid (off > 0), ascending price = ascending bin index
    let cumAsk = 0;
    for (let off = 1; off <= rowsPerSide; off++) {
      const bin = half + off;
      const size = this.currentSize[bin];
      const delta = size - this.lastSize[bin];
      cumAsk += size;
      const price = this.anchor + off * pg;
      const row: LadderRow = { price, size, delta, sum: cumAsk, isBid: false };
      asks.push(row);
      if (size > maxSize) maxSize = size;
      if (off <= topRowsForAbsorption) {
        topAbs += Math.abs(delta);
        topAbsW += delta * price;
        topAbsWeight += Math.abs(delta);
      }
    }

    // Bids: bins below mid (off < 0), descending price
    let cumBid = 0;
    for (let off = 1; off <= rowsPerSide; off++) {
      const bin = half - off;
      const size = this.currentSize[bin];
      const delta = size - this.lastSize[bin];
      cumBid += size;
      const price = this.anchor - off * pg;
      const row: LadderRow = { price, size, delta, sum: cumBid, isBid: true };
      bids.push(row);
      if (size > maxSize) maxSize = size;
      if (off <= topRowsForAbsorption) {
        topAbs += Math.abs(delta);
        topAbsW += delta * price;
        topAbsWeight += Math.abs(delta);
      }
    }

    return {
      midPrice,
      pg,
      asks,
      bids,
      maxSize,
      topAbsorption: topAbs,
      topAbsorptionPrice: topAbsWeight > 0 ? topAbsW / topAbsWeight : midPrice,
    };
  }
}
