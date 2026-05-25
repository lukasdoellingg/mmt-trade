/**
 * Short-lived WebSocket probe for /ws/heatmap.
 */

import WebSocket from 'ws';

/**
 * @param {string} wsBase e.g. ws://localhost:3001
 * @param {{ symbol?: string, tf?: string, timeoutMs?: number }} opts
 */
export function probeHeatmapWebSocket(wsBase, opts = {}) {
  const symbol = opts.symbol || 'BTCUSDT';
  const tf = opts.tf || '1h';
  const timeoutMs = opts.timeoutMs ?? 8000;
  const url = `${wsBase.replace(/\/$/, '')}/ws/heatmap?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e), frames: 0 });
      return;
    }

    let frames = 0;
    const timer = setTimeout(() => {
      finish({ ok: frames > 0, frames, error: frames ? null : 'timeout_no_frames' });
    }, timeoutMs);

    ws.on('message', () => {
      frames += 1;
      if (frames >= 1) finish({ ok: true, frames, error: null });
    });

    ws.on('error', (e) => {
      finish({ ok: false, frames, error: e.message || 'ws_error' });
    });

    ws.on('close', (code) => {
      if (!settled) finish({ ok: false, frames, error: `closed_${code}` });
    });
  });
}
