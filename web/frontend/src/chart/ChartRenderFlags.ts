/** WASM render_flags bit mask (must match odin/engine.odin). */
export const ChartRenderFlags = {
  VWAP_D: 1,
  VWAP_W: 2,
  VWAP_M: 4,
  VWAP_BANDS: 8,
  EMA: 16,
  LIQ: 32,
  ALL: 1 | 2 | 4 | 8 | 16 | 32,
} as const;

export type ChartRenderFlagsMask = number;

export class ChartRenderFlagsBuilder {
  private mask = 0;

  setVwapDaily(on: boolean): this {
    this.mask = on ? this.mask | ChartRenderFlags.VWAP_D : this.mask & ~ChartRenderFlags.VWAP_D;
    return this;
  }

  setVwapWeekly(on: boolean): this {
    this.mask = on ? this.mask | ChartRenderFlags.VWAP_W : this.mask & ~ChartRenderFlags.VWAP_W;
    return this;
  }

  setVwapMonthly(on: boolean): this {
    this.mask = on ? this.mask | ChartRenderFlags.VWAP_M : this.mask & ~ChartRenderFlags.VWAP_M;
    return this;
  }

  setVwapBands(on: boolean): this {
    this.mask = on ? this.mask | ChartRenderFlags.VWAP_BANDS : this.mask & ~ChartRenderFlags.VWAP_BANDS;
    return this;
  }

  setEma(on: boolean): this {
    this.mask = on ? this.mask | ChartRenderFlags.EMA : this.mask & ~ChartRenderFlags.EMA;
    return this;
  }

  setLiquidations(on: boolean): this {
    this.mask = on ? this.mask | ChartRenderFlags.LIQ : this.mask & ~ChartRenderFlags.LIQ;
    return this;
  }

  build(): ChartRenderFlagsMask {
    return this.mask;
  }
}
