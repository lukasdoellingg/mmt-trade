/**
 * Single HTTP upgrade router — required when multiple WebSocketServer instances
 * share one http.Server. Without this, the second WSS aborts non-matching paths
 * with HTTP 400 on already-upgraded sockets (Invalid frame header in browsers).
 */
import { WebSocketServer } from 'ws';

/**
 * @param {import('http').Server} server
 * @param {import('./security.js').WebSocketSecurityGate} webSocketGate
 * @param {{ path: string, wss: WebSocketServer }[]} routes
 */
export function mountWebSocketUpgradeRouter(server, webSocketGate, routes) {
  const routeByPath = new Map(routes.map((r) => [r.path, r.wss]));

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    const wss = routeByPath.get(pathname);
    if (!wss) {
      socket.destroy();
      return;
    }

    webSocketGate.verifyClient({ req }, (allowed, code, message) => {
      if (!allowed) {
        socket.write(`HTTP/1.1 ${code || 403} ${message || 'Forbidden'}\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });
}

/**
 * Create a WebSocketServer without attaching to http.Server (use with router).
 * @param {import('ws').ServerOptions} options
 */
export function createDetachedWebSocketServer(options = {}) {
  return new WebSocketServer({ noServer: true, perMessageDeflate: false, ...options });
}
