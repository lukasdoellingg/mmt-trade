import { WebSocketServer } from 'ws';
import {
  parseAggregateExchanges,
  aggregateUpstreamKey,
  startAggregatedHeatmap,
  closeAggregatedUpstream,
} from './heatmapAggregate.js';
import { startMmtHeatmapUpstream, closeMmtUpstream } from './mmtUpstream.js';
import { timeframeToMs } from './candleTime.js';
import { timeframeToSec } from './mmtProtocol.js';
import {
  validateHeatmapSymbol,
  createWebSocketSecurityGate,
  installHeartbeat,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
} from './security.js';
import { attachPathfulUpgrade } from './wsUpgradeRouter.js';
import { startBinanceHeatmap, closeBinanceUpstream, MAX_HEATMAP_SYMBOLS } from './binanceHeatmapUpstream.js';
import { HeatmapFrame } from './runtime.js';

export function attachHeatmapWebSocket(server, { ctx, metrics, allowedCorsOrigins, port }) {
  const webSocketGate = createWebSocketSecurityGate(allowedCorsOrigins);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });
  attachPathfulUpgrade(server, '/ws/heatmap', wss, webSocketGate);
  installHeartbeat(wss);
  const { heatmapUpstreams } = ctx;

  wss.on('connection', (socket, req) => {
    metrics.recordWsConnect();
    const clientIp = webSocketGate.trackOpen(req);
    const url = new URL(req.url, `http://localhost:${port}`);
    const requestedSymbol = validateHeatmapSymbol(url.searchParams.get('symbol'));
    if (!requestedSymbol) {
      webSocketGate.trackClose(clientIp);
      socket.close(4002, 'Invalid symbol');
      return;
    }
    const sym = requestedSymbol;
    const tf = url.searchParams.get('tf') || '1h';
    const timeframeMs = timeframeToMs(tf);
    const timeframeSec = timeframeToSec(tf);
    const exchanges = parseAggregateExchanges(url.searchParams.get('aggregate'));
    const useMmt = !!process.env.MMT_WS_TOKEN;
    const useAgg =
      !useMmt && (exchanges.length > 1 || (exchanges.length === 1 && exchanges[0] !== 'binance'));

    let upstreamKey = sym;
    let upstream;
    let mmtMode = false;

    if (useMmt) {
      upstreamKey = `MMT:${sym}:${exchanges.join(',')}`;
      mmtMode = true;
      if (heatmapUpstreams.has(upstreamKey)) {
        upstream = heatmapUpstreams.get(upstreamKey);
      } else {
        if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
          webSocketGate.trackClose(clientIp);
          socket.close(4000, 'Upstream limit reached');
          return;
        }
        upstream = startMmtHeatmapUpstream(sym, exchanges, HeatmapFrame, timeframeSec);
        if (!upstream) {
          webSocketGate.trackClose(clientIp);
          socket.close(4001, 'MMT upstream failed');
          return;
        }
        heatmapUpstreams.set(upstreamKey, upstream);
      }
    } else if (useAgg) {
      upstreamKey = aggregateUpstreamKey(sym, exchanges);
      if (heatmapUpstreams.has(upstreamKey)) {
        upstream = heatmapUpstreams.get(upstreamKey);
      } else {
        if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
          webSocketGate.trackClose(clientIp);
          socket.close(4000, 'Upstream limit reached');
          return;
        }
        upstream = startAggregatedHeatmap(sym, exchanges, HeatmapFrame, timeframeMs);
        heatmapUpstreams.set(upstreamKey, upstream);
      }
    } else {
      upstreamKey = `${sym}:${timeframeMs}`;
      if (heatmapUpstreams.has(upstreamKey)) {
        upstream = heatmapUpstreams.get(upstreamKey);
      } else {
        if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
          webSocketGate.trackClose(clientIp);
          socket.close(4000, 'Upstream limit reached');
          return;
        }
        upstream = startBinanceHeatmap(sym, timeframeMs);
        if (!upstream) {
          webSocketGate.trackClose(clientIp);
          socket.close(4003, 'Symbol not supported on Binance fallback');
          return;
        }
        heatmapUpstreams.set(upstreamKey, upstream);
      }
    }

    upstream.clients.add(socket);

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      upstream.clients.delete(socket);
      if (!upstream.clients.size) {
        if (mmtMode) {
          closeMmtUpstream(upstream);
          heatmapUpstreams.delete(upstreamKey);
        } else if (useAgg) {
          closeAggregatedUpstream(upstream);
          heatmapUpstreams.delete(upstreamKey);
        } else if (upstream.ws) {
          closeBinanceUpstream(upstream);
          heatmapUpstreams.delete(upstreamKey);
        }
      }
    });
  });

  return { wss, webSocketGate };
}
