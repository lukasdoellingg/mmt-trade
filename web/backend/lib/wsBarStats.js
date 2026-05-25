/**
 * /ws/barstats — MMT stream 13 bar stats relay (JSON). Requires MMT_WS_TOKEN.
 */
import { startMmtBarStatsUpstream, closeMmtUpstream } from './mmtUpstream.js';
import { timeframeToSec } from './mmtProtocol.js';
import { parseAggregateExchanges } from './heatmapAggregate.js';
import { validateTimeframe } from './security.js';
import { createDetachedWebSocketServer } from './wsUpgradeRouter.js';

const barStatsUpstreams = new Map();

/**
 * @param {import('./security.js').WebSocketSecurityGate} webSocketGate
 * @param {typeof validateHeatmapSymbol} validateHeatmapSymbol
 * @param {number} maxSymbols
 */
export function createBarStatsWebSocket(webSocketGate, validateHeatmapSymbol, maxSymbols = 8) {
  const wss = createDetachedWebSocketServer();

  wss.on('connection', (socket, req) => {
    const clientIp = webSocketGate.trackOpen(req);
    const url = new URL(req.url, 'http://localhost');
    const sym = validateHeatmapSymbol(url.searchParams.get('symbol'));
    if (!sym) {
      webSocketGate.trackClose(clientIp);
      socket.close(4002, 'Invalid symbol');
      return;
    }
    if (!process.env.MMT_WS_TOKEN) {
      webSocketGate.trackClose(clientIp);
      socket.close(4001, 'MMT_WS_TOKEN required for bar stats');
      return;
    }

    const tfRaw = url.searchParams.get('tf') || '1h';
    const tf = validateTimeframe(tfRaw) ?? '1h';
    const timeframeSec = timeframeToSec(tf);
    const bucketGroup = Math.max(5, Math.min(9, Number(url.searchParams.get('bucket_group') || 6) | 0));
    const exchanges = parseAggregateExchanges(url.searchParams.get('aggregate'));
    const upstreamKey = `BAR:${sym}:${exchanges.join(',')}:${timeframeSec}:${bucketGroup}`;

    let upstream = barStatsUpstreams.get(upstreamKey);
    if (!upstream) {
      if (barStatsUpstreams.size >= maxSymbols) {
        webSocketGate.trackClose(clientIp);
        socket.close(4000, 'Upstream limit reached');
        return;
      }
      upstream = startMmtBarStatsUpstream(sym, exchanges, timeframeSec, bucketGroup);
      if (!upstream) {
        webSocketGate.trackClose(clientIp);
        socket.close(4001, 'Bar stats upstream failed');
        return;
      }
      barStatsUpstreams.set(upstreamKey, upstream);
    }

    upstream.clients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', symbol: sym, tf, bucketGroup }));

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      upstream.clients.delete(socket);
      if (!upstream.clients.size) {
        closeMmtUpstream(upstream);
        barStatsUpstreams.delete(upstreamKey);
      }
    });
  });

  return wss;
}

export function closeAllBarStatsUpstreams() {
  for (const [, upstream] of barStatsUpstreams) {
    closeMmtUpstream(upstream);
    for (const client of upstream.clients) {
      try { client.close(1001, 'server shutdown'); } catch { /* ignore */ }
    }
  }
  barStatsUpstreams.clear();
}
