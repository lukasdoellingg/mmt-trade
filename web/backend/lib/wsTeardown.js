/**
 * Avoid noisy "closed before the connection was established" when tearing down
 * exchange upstreams during dev reloads / brief client disconnects.
 */
import { WebSocket } from 'ws';

export const HEATMAP_UPSTREAM_IDLE_MS = Number(process.env.HEATMAP_UPSTREAM_IDLE_MS || 20_000);

export function safeCloseWebSocket(ws) {
  if (!ws) return;
  const { readyState } = ws;
  if (readyState === WebSocket.CLOSED || readyState === WebSocket.CLOSING) return;
  // Swallow ws "closed before established" during CONNECTING teardown (dev reload / probe).
  ws.on('error', () => {});
  if (readyState === WebSocket.CONNECTING) {
    try { ws.terminate(); } catch { /* ignore */ }
    return;
  }
  ws.removeAllListeners('error');
  try { ws.close(1000, 'shutdown'); } catch { /* ignore */ }
}

export function cancelUpstreamIdleClose(upstream) {
  if (!upstream?.idleCloseTimer) return;
  clearTimeout(upstream.idleCloseTimer);
  upstream.idleCloseTimer = null;
}

/**
 * When the last heatmap client disconnects, keep upstreams alive briefly so
 * HMR / iframe reloads do not churn Binance/Bybit sockets.
 */
export function scheduleUpstreamIdleClose(upstream, onIdle) {
  cancelUpstreamIdleClose(upstream);
  upstream.idleCloseTimer = setTimeout(() => {
    upstream.idleCloseTimer = null;
    if (upstream.clients?.size > 0) return;
    onIdle();
  }, HEATMAP_UPSTREAM_IDLE_MS);
}
