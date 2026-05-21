/**
 * Recycled Uint8Array / Float32Array pool for heatmap & footprint snapshot maps.
 * Reuses released columns when snapshots are pruned instead of `.slice()`.
 */
export function createByteColumnPool(columnBytes: number) {
  const free: Uint8Array[] = [];

  return {
    take(): Uint8Array {
      const col = free.pop();
      if (col) {
        col.fill(0);
        return col;
      }
      return new Uint8Array(columnBytes);
    },
    release(col: Uint8Array): void {
      free.push(col);
    },
  };
}

export function createFloatColumnPool(floatCount: number) {
  const free: Float32Array[] = [];

  return {
    take(): Float32Array {
      const col = free.pop();
      if (col) {
        col.fill(0);
        return col;
      }
      return new Float32Array(floatCount);
    },
    release(col: Float32Array): void {
      free.push(col);
    },
  };
}
