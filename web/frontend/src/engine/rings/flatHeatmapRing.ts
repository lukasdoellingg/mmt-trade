/** Flat heatmap column metadata ring for worker handoff. */
export const FLAT_HEATMAP_RING_CAPACITY = 64;

export type FlatHeatmapColumnMeta = {
  tsMs: number;
  levelCount: number;
};

export class FlatHeatmapRing {
  private readonly columns: FlatHeatmapColumnMeta[];
  head = 0;
  tail = 0;

  constructor() {
    this.columns = new Array(FLAT_HEATMAP_RING_CAPACITY);
    for (let i = 0; i < FLAT_HEATMAP_RING_CAPACITY; i++) {
      this.columns[i] = { tsMs: 0, levelCount: 0 };
    }
  }

  push(meta: FlatHeatmapColumnMeta): boolean {
    const next = (this.tail + 1) % FLAT_HEATMAP_RING_CAPACITY;
    if (next === this.head) return false;
    this.columns[this.tail] = meta;
    this.tail = next;
    return true;
  }

  pop(): FlatHeatmapColumnMeta | null {
    if (this.head === this.tail) return null;
    const meta = this.columns[this.head];
    this.head = (this.head + 1) % FLAT_HEATMAP_RING_CAPACITY;
    return meta;
  }
}
