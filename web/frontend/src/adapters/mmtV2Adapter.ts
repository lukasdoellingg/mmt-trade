/**
 * mmt.gg /api/v2/ws adapter — lets the Vue workspace consume the same
 * subscribe/getrange/unsubscribe surface that `packages/shell` uses.
 *
 * **Not wired yet.** Current workers (`heatmapWorker.ts`, `obHeatmapWorker.ts`)
 * still use `/ws/heatmap` (legacy Protobuf schema). Phase 8 migration skeleton:
 *
 *   const conn = new MmtV2Connection(wsBaseUrl('/api/v2/ws'));
 *   conn.subscribe({ stream: STREAM.HEATMAP_OB, pair: { exchange: 'binance', symbol: 'btc/usd' },
 *                    timeframe: 3600, bucket_group: 5 }, (cborFrame) => decodeAndPaint(cborFrame));
 *   conn.ping();   // keep-alive
 *   conn.close();  // unsubscribes all
 */

export const STREAM = Object.freeze({
  CANDLES: 4,
  MULTI_AGG: 5,
  VOLUMES: 6,
  HEATMAP_OB: 13,
  AGG_TRADES: 16,
} as const);

export type StreamId = (typeof STREAM)[keyof typeof STREAM];

export interface MmtPair {
  exchange: string; // colon-separated list, e.g. 'binance:bybit'
  symbol: string; // 'btc/usd'
}

export interface SubscribeSpec {
  stream: StreamId;
  pair: MmtPair;
  timeframe?: number;
  bucket_group?: number;
}

export type FrameHandler = (frame: ArrayBuffer) => void;

interface PendingSub {
  id: number;
  spec: SubscribeSpec;
  onFrame: FrameHandler;
}

let nextReqId = 1;

export function wsBaseUrl(path = '/api/v2/ws'): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${path}`;
}

export class MmtV2Connection {
  private socket: WebSocket | null = null;
  private subs = new Map<number, PendingSub>();
  private closed = false;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly url: string) {
    this.connectPromise = this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(this.url);
      sock.binaryType = 'arraybuffer';
      sock.onopen = () => {
        this.socket = sock;
        resolve();
      };
      sock.onerror = (event) => reject(event);
      sock.onclose = () => {
        this.socket = null;
        // Auto-reconnect (1s backoff, no exponential — Phase 8 keeps it simple).
        if (!this.closed) setTimeout(() => (this.connectPromise = this.connect()), 1000);
      };
      sock.onmessage = (event) => this.dispatch(event.data as ArrayBuffer);
    });
  }

  private dispatch(rawFrame: ArrayBuffer): void {
    for (const sub of this.subs.values()) {
      sub.onFrame(rawFrame);
    }
  }

  async subscribe(spec: SubscribeSpec, onFrame: FrameHandler): Promise<number> {
    if (this.connectPromise) await this.connectPromise;
    const id = nextReqId++;
    this.subs.set(id, { id, spec, onFrame });
    this.socket?.send(JSON.stringify({ method: 'subscribe', data: spec, req_id: id }));
    return id;
  }

  unsubscribe(id: number): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.socket?.send(JSON.stringify({ method: 'unsubscribe', data: sub.spec, req_id: id }));
    this.subs.delete(id);
  }

  ping(): void {
    this.socket?.send(JSON.stringify({ method: 'ping', req_id: nextReqId++ }));
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
    this.socket?.close();
    this.socket = null;
  }
}
