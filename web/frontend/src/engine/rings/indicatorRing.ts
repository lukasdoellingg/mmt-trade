/** Server indicator plot lines + bar stats handoff ring. */
export const INDICATOR_RING_CAPACITY = 128;
export const MAX_PLOT_LINES = 32;

export type IndicatorPlotBatch = {
  runtimeId: string;
  prices: Float64Array;
  barStatsJson?: string;
};

export class IndicatorRing {
  private readonly batches: IndicatorPlotBatch[];
  head = 0;
  tail = 0;

  constructor() {
    this.batches = new Array(INDICATOR_RING_CAPACITY);
  }

  push(batch: IndicatorPlotBatch): boolean {
    const next = (this.tail + 1) % INDICATOR_RING_CAPACITY;
    if (next === this.head) return false;
    this.batches[this.tail] = batch;
    this.tail = next;
    return true;
  }

  pop(): IndicatorPlotBatch | null {
    if (this.head === this.tail) return null;
    const batch = this.batches[this.head];
    this.head = (this.head + 1) % INDICATOR_RING_CAPACITY;
    return batch ?? null;
  }
}
