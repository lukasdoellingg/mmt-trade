/**
 * /ws/aggtrade — Binance aggTrade relay for footprint layer (refcount per symbol).
 */
import { createDetachedWebSocketServer } from './wsUpgradeRouter.js';
import { acquireAggTradeUpstream, releaseAggTradeUpstream } from './chartBinanceFeed.js';
import { MAX_WEBSOCKET_PAYLOAD_BYTES } from './security.js';

/**
 * @param {import('./security.js').WebSocketSecurityGate} webSocketGate
 * @param {(sym: string | null) => string | null} validateSymbol
 */
export function createAggTradeWebSocket(webSocketGate, validateSymbol) {
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

    acquireAggTradeUpstream(sym, socket);
    socket.send(JSON.stringify({ type: 'hello', endpoint: '/ws/aggtrade', symbol: sym }));

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      releaseAggTradeUpstream(sym, socket);
    });
  });

  return wss;
}
