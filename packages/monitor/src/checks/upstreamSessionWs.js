/**
 * Short-lived WebSocket probe for /ws/session.
 */

import WebSocket from 'ws';

/**
 * @param {string} wsBase e.g. ws://localhost:3001
 * @param {{ symbol?: string, tf?: string, timeoutMs?: number }} opts
 */
export function probeSessionWebSocket(wsBase, opts = {}) {
  const symbol = opts.symbol || 'BTCUSDT';
  const tf = opts.tf || '1h';
  const timeoutMs = opts.timeoutMs ?? 8000;
  const url = `${wsBase.replace(/\/$/, '')}/ws/session?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`;

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
      finish({ ok: false, error: e instanceof Error ? e.message : String(e), hello: false });
      return;
    }

    let hello = false;
    const timer = setTimeout(() => {
      finish({ ok: hello, hello, error: hello ? null : 'timeout_no_hello' });
    }, timeoutMs);

    ws.on('message', (raw) => {
      if (typeof raw === 'string') {
        try {
          const j = JSON.parse(raw);
          if (j.type === 'hello') {
            hello = true;
            finish({ ok: true, hello: true, error: null });
          }
        } catch { /* ignore */ }
      }
    });

    ws.on('error', (e) => {
      finish({ ok: false, hello, error: e.message || 'ws_error' });
    });

    ws.on('close', (code) => {
      if (!settled) finish({ ok: false, hello, error: `closed_${code}` });
    });
  });
}
