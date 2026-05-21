/**
 * Connects terminal.wasm to the backend /ws/heatmap proxy (MMT or Binance fallback).
 * Decodes HeatmapFrame protobuf and writes levels into WASM via mmt_feed_heatmap_frame.
 */

import { decodeHeatmapFrame } from './heatmap-proto';

export interface HeatmapBridgeOptions {
  symbol?: string;
  timeframe?: string;
  aggregate?: string;
  onStatus?: (message: string) => void;
}

interface FeedModule {
  HEAPF64: Float64Array;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _mmt_feed_heatmap_frame(
    bucketTsMs: number,
    pricesPtr: number,
    volumesPtr: number,
    flagsPtr: number,
    levelCount: number,
  ): number;
}

const MAX_LEVELS = 800;

function wsHeatmapUrl(options: HeatmapBridgeOptions): string {
  const params = new URLSearchParams();
  params.set('symbol', options.symbol ?? 'btcusdt');
  params.set('tf', options.timeframe ?? '1h');
  if (options.aggregate) {
    params.set('aggregate', options.aggregate);
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/heatmap?${params.toString()}`;
}

export class HeatmapBridge {
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private destroyed = false;

  constructor(
    private readonly module: FeedModule,
    private readonly options: HeatmapBridgeOptions = {},
  ) {}

  connect(): void {
    if (this.destroyed) return;
    const url = wsHeatmapUrl(this.options);
    this.options.onStatus?.(`Heatmap WS ${url}`);
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = () => {
      this.options.onStatus?.('Heatmap stream connected');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = 0;
      }
    };

    this.socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const frame = decodeHeatmapFrame(event.data);
      if (!frame) return;
      this.feedFrame(frame.ts, frame.levels);
    };

    this.socket.onclose = () => {
      if (this.destroyed) return;
      this.options.onStatus?.('Heatmap stream closed — reconnecting…');
      this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
    };

    this.socket.onerror = () => {
      this.options.onStatus?.('Heatmap stream error');
    };
  }

  private feedFrame(bucketTs: number, levels: { price: number; volume: number; isBid: boolean }[]): void {
    const count = Math.min(levels.length, MAX_LEVELS);
    if (count <= 0) return;

    const pricesPtr = this.module._malloc(count * 8);
    const volumesPtr = this.module._malloc(count * 8);
    const flagsPtr = this.module._malloc(count);

    try {
      const prices = this.module.HEAPF64.subarray(pricesPtr / 8, pricesPtr / 8 + count);
      const volumes = this.module.HEAPF64.subarray(volumesPtr / 8, volumesPtr / 8 + count);
      const flags = this.module.HEAPU8.subarray(flagsPtr, flagsPtr + count);
      for (let i = 0; i < count; i++) {
        prices[i] = levels[i].price;
        volumes[i] = levels[i].volume;
        flags[i] = levels[i].isBid ? 1 : 0;
      }
      const bucketMs = bucketTs > 1e12 ? bucketTs : bucketTs * 1000;
      this.module._mmt_feed_heatmap_frame(bucketMs, pricesPtr, volumesPtr, flagsPtr, count);
    } finally {
      this.module._free(pricesPtr);
      this.module._free(volumesPtr);
      this.module._free(flagsPtr);
    }
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

export function startHeatmapBridge(module: FeedModule, options?: HeatmapBridgeOptions): HeatmapBridge {
  const bridge = new HeatmapBridge(module, options);
  bridge.connect();
  return bridge;
}
