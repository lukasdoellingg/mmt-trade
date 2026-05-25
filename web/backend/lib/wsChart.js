/**
 * /ws/chart — Binance kline + forceOrder relay (refcount upstream per symbol/interval).
 */
import { createDetachedWebSocketServer } from './wsUpgradeRouter.js';
import { acquireChartUpstream, releaseChartUpstream, chartIntervalToBinance } from './chartBinanceFeed.js';
import { validateTimeframe, MAX_WEBSOCKET_PAYLOAD_BYTES } from './security.js';

/**
 * @param {import('./security.js').WebSocketSecurityGate} webSocketGate
 * @param {(sym: string | null) => string | null} validateSymbol
 */
export function createChartWebSocket(webSocketGate, validateSymbol) {
  const wss = createDetachedWebSocketServer({ maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });

  wss.on('connection', (socket, req) => {
    const clientIp = webSocketGate.trackOpen(req);
    const url = new URL(req.url, 'http://localhost');
    const sym = validateSymbol(url.searchParams.get('symbol'));
    if (!sym) {
      webSocketGate.trackClose(clientIp);
      socket.close(4002, 'Invalid symbol');
      return;
    }
    const tf = validateTimeframe(url.searchParams.get('tf') || '1h') ?? '1h';
    const interval = chartIntervalToBinance(tf);

    acquireChartUpstream(sym, interval, socket);
    socket.send(JSON.stringify({ type: 'hello', endpoint: '/ws/chart', symbol: sym, tf }));

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      releaseChartUpstream(sym, interval, socket);
    });
  });

  return wss;
}
