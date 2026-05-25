// ═══════════════════════════════════════════════════════════════
//  useDrawings — Stateful drawing-tool layer for the chart.
//
//  Anchors shapes in (timestamp, price) space so they stay glued
//  to the chart through pan/zoom and history loads. Renders to a
//  2D canvas overlay on top of the WebGL heatmap.
//
//  Supported tools: trendline, hline, vline, rect.
//  Eraser tool removes the topmost drawing under the cursor.
// ═══════════════════════════════════════════════════════════════

import { ref, shallowRef } from 'vue';

export type DrawingType = 'trendline' | 'hline' | 'vline' | 'rect';
export interface DrawingAnchor {
  t: number;
  p: number;
}
export interface Drawing {
  id: string;
  type: DrawingType;
  pts: DrawingAnchor[];
  color: string;
  width: number;
}

export interface DrawingsApi {
  /** Reactive list of committed drawings. */
  drawings: ReturnType<typeof shallowRef<Drawing[]>>;
  /** Current pending shape, if any. */
  pending: ReturnType<typeof ref<Drawing | null>>;
  /** True while drawing in progress. */
  isDrawing: ReturnType<typeof ref<boolean>>;
  /** Add anchor at cursor (start, second-click, etc.). Returns true if shape committed. */
  addAnchor(type: DrawingType, t: number, p: number, color: string): boolean;
  /** Update last anchor (for preview while moving cursor). */
  updateCursor(t: number, p: number): void;
  /** Cancel pending shape. */
  cancel(): void;
  /** Remove drawing whose path passes within `tolPx` of (x, y). */
  eraseAt(x: number, y: number, tolPx: number, xy: (a: DrawingAnchor) => [number, number]): boolean;
  /** Clear everything. */
  clear(): void;
  /** Render committed + pending drawings into 2D ctx. */
  render(
    ctx: CanvasRenderingContext2D,
    xy: (a: DrawingAnchor) => [number, number],
    plotW: number,
    plotH: number,
    dpr: number,
  ): void;
}

let _idSeed = 0;
function nextId(): string {
  return 'd' + (_idSeed++).toString(36);
}

const ANCHOR_COUNTS: Record<DrawingType, number> = {
  trendline: 2,
  hline: 1,
  vline: 1,
  rect: 2,
};

export function useDrawings(): DrawingsApi {
  const drawings = shallowRef<Drawing[]>([]);
  const pending = ref<Drawing | null>(null);
  const isDrawing = ref(false);

  function addAnchor(type: DrawingType, t: number, p: number, color: string): boolean {
    const need = ANCHOR_COUNTS[type];
    if (!pending.value || pending.value.type !== type) {
      pending.value = { id: nextId(), type, pts: [{ t, p }], color, width: 1.6 };
      isDrawing.value = true;
      if (need === 1) {
        drawings.value = [...drawings.value, pending.value];
        pending.value = null;
        isDrawing.value = false;
        return true;
      }
      return false;
    }
    pending.value.pts.push({ t, p });
    if (pending.value.pts.length >= need) {
      drawings.value = [...drawings.value, pending.value];
      pending.value = null;
      isDrawing.value = false;
      return true;
    }
    return false;
  }

  function updateCursor(t: number, p: number) {
    const d = pending.value;
    if (!d) return;
    const need = ANCHOR_COUNTS[d.type];
    // Preview last anchor as cursor position
    if (d.pts.length < need) {
      const previewPts: DrawingAnchor[] = d.pts.slice();
      previewPts.push({ t, p });
      pending.value = { ...d, pts: previewPts };
    }
  }

  function cancel() {
    pending.value = null;
    isDrawing.value = false;
  }

  function clear() {
    drawings.value = [];
    pending.value = null;
    isDrawing.value = false;
  }

  function distPointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const ex = px - ax,
        ey = py - ay;
      return Math.sqrt(ex * ex + ey * ey);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const qx = ax + t * dx,
      qy = ay + t * dy;
    const ex = px - qx,
      ey = py - qy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  function eraseAt(x: number, y: number, tolPx: number, xy: (a: DrawingAnchor) => [number, number]): boolean {
    const list = drawings.value;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      let hit = false;
      if (d.type === 'trendline' && d.pts.length === 2) {
        const [x1, y1] = xy(d.pts[0]);
        const [x2, y2] = xy(d.pts[1]);
        hit = distPointSegment(x, y, x1, y1, x2, y2) <= tolPx;
      } else if (d.type === 'hline' && d.pts.length === 1) {
        const [, y1] = xy(d.pts[0]);
        hit = Math.abs(y - y1) <= tolPx;
      } else if (d.type === 'vline' && d.pts.length === 1) {
        const [x1] = xy(d.pts[0]);
        hit = Math.abs(x - x1) <= tolPx;
      } else if (d.type === 'rect' && d.pts.length === 2) {
        const [x1, y1] = xy(d.pts[0]);
        const [x2, y2] = xy(d.pts[1]);
        const xmin = Math.min(x1, x2),
          xmax = Math.max(x1, x2);
        const ymin = Math.min(y1, y2),
          ymax = Math.max(y1, y2);
        // Hit if near any edge (not interior — interior hit would block panning)
        const nearLR =
          (Math.abs(x - xmin) <= tolPx || Math.abs(x - xmax) <= tolPx) &&
          y >= ymin - tolPx &&
          y <= ymax + tolPx;
        const nearTB =
          (Math.abs(y - ymin) <= tolPx || Math.abs(y - ymax) <= tolPx) &&
          x >= xmin - tolPx &&
          x <= xmax + tolPx;
        hit = nearLR || nearTB;
      }
      if (hit) {
        const next = list.slice();
        next.splice(i, 1);
        drawings.value = next;
        return true;
      }
    }
    return false;
  }

  // Parses '#rrggbb' once into a stable rgb triple for the rect fill. Avoids re-parsing
  // strokeStyle every frame and the dependency on Canvas2D string round-tripping.
  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace(/^#/, '');
    if (h.length !== 6) return [240, 192, 75];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function strokeShape(
    ctx: CanvasRenderingContext2D,
    d: Drawing,
    xy: (a: DrawingAnchor) => [number, number],
    plotW: number,
    plotH: number,
    dpr: number,
  ) {
    ctx.strokeStyle = d.color;
    // Width is in CSS pixels — multiply by DPR so high-DPI canvases get the
    // correct on-screen stroke instead of a hairline.
    ctx.lineWidth = Math.max(1, d.width * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (d.type === 'trendline' && d.pts.length === 2) {
      const [x1, y1] = xy(d.pts[0]);
      const [x2, y2] = xy(d.pts[1]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (d.type === 'hline' && d.pts.length >= 1) {
      const [, y] = xy(d.pts[0]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
    } else if (d.type === 'vline' && d.pts.length >= 1) {
      const [x] = xy(d.pts[0]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
    } else if (d.type === 'rect' && d.pts.length === 2) {
      const [x1, y1] = xy(d.pts[0]);
      const [x2, y2] = xy(d.pts[1]);
      const x = Math.min(x1, x2),
        y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1),
        h = Math.abs(y2 - y1);
      const [r, g, b] = hexToRgb(d.color);
      ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }

  function render(
    ctx: CanvasRenderingContext2D,
    xy: (a: DrawingAnchor) => [number, number],
    plotW: number,
    plotH: number,
    dpr: number,
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();
    for (let i = 0; i < drawings.value.length; i++) {
      strokeShape(ctx, drawings.value[i], xy, plotW, plotH, dpr);
    }
    if (pending.value) {
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      strokeShape(ctx, pending.value, xy, plotW, plotH, dpr);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  return { drawings, pending, isDrawing, addAnchor, updateCursor, cancel, eraseAt, clear, render };
}
