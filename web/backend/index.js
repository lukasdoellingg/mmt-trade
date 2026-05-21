import { createApp } from './createApp.js';
import { attachHeatmapWebSocket } from './lib/wsHeatmap.js';

const PORT = Number(process.env.PORT || 3001);

const { app, ctx, metrics, allowedCorsOrigins } = createApp();

const server = app.listen(PORT, () => console.log(`MMT-Trade Backend on http://localhost:${PORT}`));

const { wss } = attachHeatmapWebSocket(server, { ctx, metrics, allowedCorsOrigins, port: PORT });

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  ctx.closeExchangeCache();
  for (const [, upstream] of ctx.heatmapUpstreams) {
    try {
      upstream.ws?.close();
    } catch {
      /* ignore */
    }
    for (const client of upstream.clients) {
      try {
        client.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
    }
  }
  ctx.heatmapUpstreams.clear();
  wss.close();
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
