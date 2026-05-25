/**
 * Shared OB heatmap layer — used by obHeatmapWorker (legacy) and chartEngineWorker (Emscripten path).
 */
import { decodeHeatmapFrame, type HeatmapLevel } from './heatmapProto';
import { ObHeatmapRenderer, TIME_COLS } from './ObHeatmapRenderer';
import {
  emptyColumn,
  writeLevelsToColumn,
  candleOpenTs,
  prepareColumnForDisplay,
  lowCutoffVolume,
  type BinMode,
} from './obColumn';

const MARGIN_RIGHT = 80;
const MARGIN_BOTTOM = 32;
const CANDLE_FIELD_STRIDE = 7;
const SNAPSHOT_CAP = 5000;

const TF_MS: Record<string, number> = {
  '1m': 60e3, '15m': 9e5, '30m': 18e5, '1h': 36e5,
  '4h': 144e5, '1D': 864e5, '1W': 6048e5,
};

export type ObHeatmapStats = {
  levels: number;
  snapshots: number;
  liveTs: number;
};

export class ObHeatmapController {
  private timeframe = '1h';
  private timeframeMs = 36e5;
  private running = false;

  private canvasW = 800;
  private canvasH = 600;
  private devicePR = 1;

  private minPrice = 0;
  private maxPrice = 1;
  private hasPriceRange = false;

  private visStart = 0;
  private visEnd = 500;
  private timeAxisDirty = true;
  private lastCandleBuf: Float64Array | null = null;
  private lastCandleCount = 0;

  private snapshotByTs = new Map<number, Uint8Array>();
  private liveCandleTs = 0;
  private liveColumn: Uint8Array | null = null;

  private offscreen: OffscreenCanvas | null = null;
  private renderer: ObHeatmapRenderer | null = null;
  private frameDirty = false;

  private lowNorm = 0;
  private peakSize = 0.85;
  private intensityMul = 1.65;
  private lastLevelCount = 0;
  private snapshotCount = 0;
  private binMode: BinMode = 'hd';
  private refVolume = 0;

  plotRect() {
    const pr = this.devicePR;
    return { x: 0, y: 0, w: this.canvasW - MARGIN_RIGHT * pr, h: this.canvasH - MARGIN_BOTTOM * pr };
  }

  resetSnapshots(): void {
    this.snapshotByTs.clear();
    this.liveCandleTs = 0;
    this.liveColumn = null;
    this.timeAxisDirty = true;
  }

  private pruneSnapshots(): void {
    if (this.snapshotByTs.size <= SNAPSHOT_CAP) return;
    const keys = [...this.snapshotByTs.keys()].sort((a, b) => a - b);
    const drop = keys.length - SNAPSHOT_CAP;
    for (let i = 0; i < drop; i++) this.snapshotByTs.delete(keys[i]);
  }

  private finalizeLiveCandle(): void {
    if (this.liveCandleTs > 0 && this.liveColumn) {
      this.snapshotByTs.set(this.liveCandleTs, this.liveColumn.slice());
      this.pruneSnapshots();
    }
  }

  onObFrame(frameTs: number, levels: HeatmapLevel[]): ObHeatmapStats | null {
    if (!this.hasPriceRange || !levels.length) return null;
    const openTs = candleOpenTs(frameTs, this.timeframeMs);
    if (openTs !== this.liveCandleTs) {
      this.finalizeLiveCandle();
      this.liveCandleTs = openTs;
      this.liveColumn = emptyColumn();
    }
    if (!this.liveColumn) this.liveColumn = emptyColumn();

    let frameMax = 0;
    for (let i = 0; i < levels.length; i++) {
      const v = levels[i].volume;
      if (v > frameMax) frameMax = v;
    }
    this.refVolume = this.refVolume * 0.6 + frameMax * 0.4;

    const cutoff = lowCutoffVolume(this.lowNorm, this.refVolume);
    writeLevelsToColumn(this.liveColumn, levels, this.minPrice, this.maxPrice, false, cutoff);
    this.lastLevelCount = levels.length;
    this.snapshotCount = this.snapshotByTs.size + (this.liveColumn ? 1 : 0);
    this.timeAxisDirty = true;
    return { levels: this.lastLevelCount, snapshots: this.snapshotCount, liveTs: this.liveCandleTs };
  }

  onHeatmapBuffer(buffer: ArrayBuffer): ObHeatmapStats | null {
    const frame = decodeHeatmapFrame(buffer);
    if (!frame?.levels.length) return null;
    return this.onObFrame(frame.ts, frame.levels);
  }

  private rebuildTexture(): void {
    if (!this.renderer || !this.hasPriceRange) return;
    this.renderer.clearTexture();
    const span = this.visEnd - this.visStart;
    if (span <= 0) return;

    const cols = Math.min(TIME_COLS, Math.max(1, span));
    for (let c = 0; c < cols; c++) {
      const candleIdx =
        span <= TIME_COLS
          ? this.visStart + c
          : this.visStart + Math.floor((c * span) / cols);
      if (candleIdx < 0 || candleIdx >= this.lastCandleCount) continue;

      let openTs = 0;
      if (this.lastCandleBuf && this.lastCandleCount > 0) {
        openTs = this.lastCandleBuf[candleIdx * CANDLE_FIELD_STRIDE];
      } else {
        openTs = this.liveCandleTs;
      }

      let colData = this.snapshotByTs.get(openTs);
      if (!colData && openTs === this.liveCandleTs && this.liveColumn) {
        colData = this.liveColumn;
      }
      if (!colData) continue;

      const texCol =
        span <= TIME_COLS
          ? c
          : Math.floor((c * TIME_COLS) / cols);
      const displayCol = prepareColumnForDisplay(colData, this.binMode);
      this.renderer.blitColumn(texCol, displayCol);
    }
    this.frameDirty = true;
  }

  /** Call once per animation frame when layer is active. */
  tick(): void {
    if (!this.running) return;
    if (this.timeAxisDirty && this.renderer) {
      this.rebuildTexture();
      this.timeAxisDirty = false;
    }
    if (!this.frameDirty || !this.renderer) return;
    this.frameDirty = false;
    this.renderer.uploadTexture();
    const p = this.plotRect();
    this.renderer.render(p.x, p.y, p.w, p.h, this.intensityMul);
  }

  async initCanvas(canvas: OffscreenCanvas, w: number, h: number, dpr: number): Promise<string | null> {
    this.canvasW = w;
    this.canvasH = h;
    this.devicePR = dpr;
    this.offscreen = canvas;
    canvas.width = w;
    canvas.height = h;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) return 'WebGL2 required for OB heatmap';
    try {
      this.renderer = new ObHeatmapRenderer(gl);
      this.renderer.resize(w, h);
      this.running = true;
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  setTimeframe(tf: string): void {
    if (tf === this.timeframe) return;
    this.timeframe = tf;
    this.timeframeMs = TF_MS[tf] || 36e5;
    this.resetSnapshots();
  }

  setPriceRange(minPrice: number, maxPrice: number): void {
    this.minPrice = minPrice;
    this.maxPrice = maxPrice;
    this.hasPriceRange = maxPrice > minPrice;
    this.timeAxisDirty = true;
  }

  setTimeAxis(
    visStart: number,
    visEnd: number,
    candleTsBuf: Float64Array | null,
    candleCount: number,
    tf?: string,
  ): void {
    this.visStart = visStart;
    this.visEnd = visEnd;
    if (tf) this.setTimeframe(tf);
    if (candleTsBuf) {
      this.lastCandleBuf = candleTsBuf;
      this.lastCandleCount = candleCount;
    }
    this.timeAxisDirty = true;
  }

  setIntensity(lowSize: number, peakSize: number): void {
    this.lowNorm = lowSize;
    this.peakSize = Math.max(0.1, peakSize);
    this.intensityMul = 0.9 + this.peakSize * 1.1;
    this.timeAxisDirty = true;
    this.frameDirty = true;
  }

  setBinMode(mode: BinMode): void {
    this.binMode = mode;
    this.timeAxisDirty = true;
  }

  resize(w: number, h: number, dpr: number): void {
    this.canvasW = w;
    this.canvasH = h;
    this.devicePR = dpr;
    if (this.offscreen) {
      this.offscreen.width = w;
      this.offscreen.height = h;
    }
    this.renderer?.resize(w, h);
    this.timeAxisDirty = true;
    this.frameDirty = true;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  destroy(): void {
    this.running = false;
    this.renderer = null;
    this.offscreen = null;
  }
}
