/** Cap DPR for chart canvases — 1.5 keeps text sharp without 4K framebuffer blow-up. */
export const CHART_MAX_DPR = 1.5;

/** Max pixel dimension per canvas side (8 stacked layers × ~15 MB @ 4096² RGBA). */
export const CHART_MAX_CANVAS_PX = 3840;

export function chartDevicePixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, CHART_MAX_DPR);
}

/** CSS layout size → backing-store pixels, clamped for GPU budget. */
export function chartCanvasPixelSize(cssWidth: number, cssHeight: number): { w: number; h: number } {
  const dpr = chartDevicePixelRatio();
  let w = Math.max(200, (cssWidth * dpr) | 0);
  let h = Math.max(200, (cssHeight * dpr) | 0);
  const maxSide = Math.max(w, h);
  if (maxSide > CHART_MAX_CANVAS_PX) {
    const scale = CHART_MAX_CANVAS_PX / maxSide;
    w = (w * scale) | 0;
    h = (h * scale) | 0;
  }
  return { w, h };
}
