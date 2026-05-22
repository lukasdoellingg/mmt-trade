/**
 * Centralised HTTP-upgrade routing so multiple WebSocketServer instances can
 * coexist on the same `http.Server`.
 *
 * Each call to `attachPathfulUpgrade(server, path, wss, gate)` registers ONE
 * upgrade listener that:
 *   1. Filters requests by exact `pathname` match (ignoring `?token=...` etc).
 *   2. Runs the per-server `gate.verifyClient` (Origin allow-list, IP cap).
 *   3. Calls `wss.handleUpgrade(...)` so the WSS only sees its own traffic.
 *
 * Without this, two `new WebSocketServer({ server, path })` instances both
 * subscribe to the same `upgrade` event and race for the socket — the loser
 * synthesises a 400 response and the client sees `Unexpected server response: 400`.
 */

export function attachPathfulUpgrade(server, expectedPath, wss, gate) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== expectedPath) return;

    const info = {
      req,
      origin: req.headers.origin,
      secure: req.connection?.encrypted === true,
    };
    gate.verifyClient(info, (allowed, status, reason) => {
      if (!allowed) {
        socket.write(
          `HTTP/1.1 ${status || 403} ${reason || 'Forbidden'}\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });
}
