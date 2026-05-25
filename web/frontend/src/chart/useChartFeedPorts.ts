/**
 * Chart feed-hub port wiring — extracted from ChartWidget (IPO B1 split).
 */
import { acquireHeatmapFeed } from '../features/heatmap/feed-hub/heatmapFeedHub';
import {
  attachFeedPort,
  detachFeedPort,
  streamKeyFromSpec,
  subscribeFeedPortStream,
} from '../engine/feedHubClient';
import { USE_EMSCRIPTEN_OB_HEATMAP, USE_SESSION_MUX } from '../config/featureFlags';

export type ChartFeedPortsHost = {
  settings: {
    symbol: string;
    timeframe: string;
    obHeatmap: boolean;
    obAggregate: boolean;
  };
  getWorker: () => Worker | null;
  getObWorker: () => Worker | null;
  getReleaseObFeed: () => (() => void) | null;
  setReleaseObFeed: (fn: (() => void) | null) => void;
  getObFeedPortAttached: () => boolean;
  setObFeedPortAttached: (v: boolean) => void;
  getObFeedPort: () => MessagePort | null;
  setObFeedPort: (p: MessagePort | null) => void;
  getChartFeedPort: () => MessagePort | null;
  setChartFeedStreamKey: (k: string) => void;
  getChartFeedStreamKey: () => string;
  toBinanceSymbol: (sym: string) => string;
  obAggregateParam: () => string;
  onHeatmapBuffer: (buffer: ArrayBuffer) => void;
};

export function attachObFeedPortToWorker(host: ChartFeedPortsHost, target: Worker | null): void {
  if (!target || !USE_SESSION_MUX || host.getObFeedPortAttached()) return;
  const mc = new MessageChannel();
  host.setObFeedPort(mc.port2);
  attachFeedPort(mc.port2);
  target.postMessage({ type: 'initFeedPort', port: mc.port1 }, [mc.port1]);
  host.setObFeedPortAttached(true);
}

export function attachObFeedPort(host: ChartFeedPortsHost): void {
  const target = USE_EMSCRIPTEN_OB_HEATMAP ? host.getWorker() : host.getObWorker();
  attachObFeedPortToWorker(host, target);
}

export function stopObFeed(host: ChartFeedPortsHost): void {
  const release = host.getReleaseObFeed();
  if (release) {
    release();
    host.setReleaseObFeed(null);
  }
}

export function startObFeed(host: ChartFeedPortsHost): void {
  stopObFeed(host);
  if (!host.settings.obHeatmap) return;
  const sym = host.toBinanceSymbol(host.settings.symbol);
  const aggregate = host.obAggregateParam();
  if (USE_SESSION_MUX) attachObFeedPort(host);
  const target = USE_EMSCRIPTEN_OB_HEATMAP ? host.getWorker() : host.getObWorker();
  if (!target) return;
  host.setReleaseObFeed(
    acquireHeatmapFeed(sym, host.settings.timeframe, aggregate, (buffer) => {
      const t = USE_EMSCRIPTEN_OB_HEATMAP ? host.getWorker() : host.getObWorker();
      if (!t) return;
      host.onHeatmapBuffer(buffer);
    }),
  );
}

export function syncChartFeedPortSubscriptions(host: ChartFeedPortsHost): void {
  const port = host.getChartFeedPort();
  if (!port || !USE_SESSION_MUX) return;
  const spec = {
    symbol: host.settings.symbol,
    timeframe: host.settings.timeframe,
    stream: 16,
    bucketGroup: 0,
    aggregate: 'binance',
  };
  const nextKey = streamKeyFromSpec(spec);
  const prevKey = host.getChartFeedStreamKey();
  if (prevKey && prevKey !== nextKey) {
    port.postMessage({ type: 'unsubscribe_stream', streamKey: prevKey });
  }
  if (nextKey !== prevKey) {
    subscribeFeedPortStream(port, spec);
    host.setChartFeedStreamKey(nextKey);
  }
}

export function teardownObFeedPort(host: ChartFeedPortsHost): void {
  host.setObFeedPortAttached(false);
  const port = host.getObFeedPort();
  if (port) {
    detachFeedPort(port);
    host.setObFeedPort(null);
  }
}
