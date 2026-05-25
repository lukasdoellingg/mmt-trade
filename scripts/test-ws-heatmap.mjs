#!/usr/bin/env node
import WebSocket from 'ws';

const cases = [
  { url: 'ws://localhost:3001/ws/heatmap?symbol=BTCUSDT&tf=1h', label: 'plain' },
  { url: 'ws://localhost:3001/ws/heatmap?symbol=BTCUSDT&tf=1h&aggregate=binance,bybit', label: 'agg-spot' },
  { url: 'ws://localhost:3001/ws/heatmap?symbol=BTCUSDT&tf=1h&aggregate=binancef,bybitf', label: 'agg-perp' },
];

for (const { url, label } of cases) {
  for (const deflate of [false, true]) {
    await new Promise((resolve) => {
      const ws = new WebSocket(url, { perMessageDeflate: deflate });
      let frames = 0;
      const t = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 3000);
      ws.on('open', () => {});
      ws.on('message', () => {
        frames++;
      });
      ws.on('error', (e) => {
        console.log(label, 'deflate=', deflate, 'ERR', e.message);
        clearTimeout(t);
        resolve(null);
      });
      ws.on('close', (code) => {
        console.log(label, 'deflate=', deflate, 'close', code, 'frames', frames);
        clearTimeout(t);
        resolve(null);
      });
    });
  }
}
