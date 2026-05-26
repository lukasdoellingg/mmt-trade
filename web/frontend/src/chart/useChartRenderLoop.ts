/**
 * Main-thread chart overlay render loop — idle-stop rAF (IPO A1).
 * Extracted from ChartWidget (IPO B1 split).
 */
export type ChartRenderLoopHost = {
  getVpDirty: () => boolean;
  setVpDirty: (v: boolean) => void;
  getCameraDirty: () => boolean;
  setCameraDirty: (v: boolean) => void;
  getYDirty: () => boolean;
  setYDirty: (v: boolean) => void;
  getGridDirty: () => boolean;
  getCrossDirty: () => boolean;
  getKineticActive: () => boolean;
  getTargetMinPrice: () => number;
  getTargetMaxPrice: () => number;
  getDisplayedMinPrice: () => number;
  getDisplayedMaxPrice: () => number;
  tickKinetic: (now: number) => void;
  onViewportSync: () => void;
  onCameraSync: () => void;
  onYScaleSync: () => void;
  onPriceLerp: () => void;
  drawGrid: () => void;
  drawCross: () => void;
  getCrosshairDrawState: () => { cx: number; cy: number; drawnCX: number; drawnCY: number };
};

export function createChartRenderLoop(host: ChartRenderLoopHost) {
  let animFrameId = 0;

  function needsChartFrame(): boolean {
    if (host.getVpDirty() || host.getCameraDirty() || host.getYDirty()) return true;
    if (host.getKineticActive()) return true;
    if (host.getGridDirty() || host.getCrossDirty()) return true;
    const tMin = host.getTargetMinPrice();
    const tMax = host.getTargetMaxPrice();
    if (tMin > 0 && tMax > tMin) {
      const dMin = tMin - host.getDisplayedMinPrice();
      const dMax = tMax - host.getDisplayedMaxPrice();
      const range = tMax - tMin;
      const eps = range * 0.0005;
      if (Math.abs(dMin) > eps || Math.abs(dMax) > eps) return true;
    }
    return false;
  }

  function scheduleFrame() {
    if (animFrameId) return;
    animFrameId = requestAnimationFrame(frame);
  }

  function frame() {
    animFrameId = 0;
    host.tickKinetic(performance.now());

    if (host.getVpDirty()) {
      host.setVpDirty(false);
      host.setCameraDirty(false);
      host.onViewportSync();
    } else if (host.getCameraDirty()) {
      host.setCameraDirty(false);
      host.onCameraSync();
    }
    if (host.getYDirty()) {
      host.setYDirty(false);
      host.onYScaleSync();
    }

    host.onPriceLerp();

    const plotDirty = host.getGridDirty();
    if (plotDirty) host.drawGrid();
    const ch = host.getCrosshairDrawState();
    if (plotDirty || host.getCrossDirty() || ch.cx !== ch.drawnCX || ch.cy !== ch.drawnCY) host.drawCross();

    if (needsChartFrame()) scheduleFrame();
  }

  function pause() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = 0;
    }
  }

  return { scheduleFrame, pause, needsChartFrame };
}
