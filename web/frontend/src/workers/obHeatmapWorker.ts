/**
 * MMT.gg-style OB heatmap layer (legacy dedicated worker — default path).
 */
import { ObHeatmapController } from '../engine/obHeatmapController';

const controller = new ObHeatmapController();
let animId = 0;

function loop() {
  if (!animId) return;
  animId = requestAnimationFrame(loop);
  controller.tick();
}

function post(msg: unknown) {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      controller.resetSnapshots();
      if (msg.canvas) {
        const err = await controller.initCanvas(
          msg.canvas as OffscreenCanvas,
          msg.w || 800,
          msg.h || 600,
          msg.dpr || 1,
        );
        if (err) { post({ type: 'fatal', msg: err }); return; }
        post({ type: 'ready' });
      }
      animId = requestAnimationFrame(loop);
      break;
    }
    case 'initFeedPort':
      if (msg.port) {
        (msg.port as MessagePort).onmessage = (pev: MessageEvent) => {
          const inner = pev.data;
          if (inner.type === 'session_frame' && inner.buffer instanceof ArrayBuffer) {
            const stats = controller.onHeatmapBuffer(inner.buffer);
            if (stats) post({ type: 'stats', ...stats });
          }
        };
      }
      break;
    case 'obFrame': {
      const stats = controller.onHeatmapBuffer(msg.buffer as ArrayBuffer);
      if (stats) post({ type: 'stats', ...stats });
      break;
    }
    case 'setSymbol':
      controller.resetSnapshots();
      break;
    case 'setTimeframe':
      controller.setTimeframe(msg.tf as string);
      break;
    case 'setPriceRange':
      controller.setPriceRange(msg.minPrice, msg.maxPrice);
      break;
    case 'setTimeAxis':
      controller.setTimeAxis(
        msg.visStart | 0,
        msg.visEnd | 0,
        msg.candleTsBuf instanceof Float64Array ? msg.candleTsBuf : null,
        msg.candleCount | 0,
        msg.tf,
      );
      break;
    case 'setIntensity':
      controller.setIntensity(
        typeof msg.lowSize === 'number' ? msg.lowSize : 0,
        typeof msg.peakSize === 'number' ? msg.peakSize : 0.85,
      );
      break;
    case 'setBinMode':
      controller.setBinMode(msg.mode === 'sd' ? 'sd' : 'hd');
      break;
    case 'resize':
      controller.resize(msg.w || 800, msg.h || 600, msg.dpr || 1);
      break;
    case 'pause':
      controller.pause();
      if (animId) { cancelAnimationFrame(animId); animId = 0; }
      break;
    case 'resume':
      controller.resume();
      if (!animId) animId = requestAnimationFrame(loop);
      break;
    case 'stop':
      controller.destroy();
      if (animId) cancelAnimationFrame(animId);
      animId = 0;
      break;
  }
};

export {};
