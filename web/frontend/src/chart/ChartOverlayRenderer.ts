/**
 * MMT.gg-style 2D overlays: plot grid (under WebGL) + axis chrome (on top).
 */
const FONT = 'Consolas, "Courier New", monospace';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const THOUSANDS_RE = /\B(?=(\d{3})+(?!\d))/g;

export interface ChartOverlayLayout {
  W: number;
  H: number;
  PW: number;
  PH: number;
  DPR: number;
  MR: number;
  MB: number;
}

export interface VwapAxisLabel {
  on: boolean;
  text: string;
  price: number;
  color: string;
  fg: string;
}

export class ChartOverlayRenderer {
  private readonly pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  private readonly axisDate = new Date(0);

  fmtPrice(p: number): string {
    if (p >= 100_000) return p.toFixed(0).replace(THOUSANDS_RE, ',');
    if (p >= 10_000) return p.toFixed(1).replace(THOUSANDS_RE, ',');
    if (p >= 1000) return p.toFixed(2).replace(THOUSANDS_RE, ',');
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(6);
  }

  p2y(p: number, dispMin: number, dispMax: number, PH: number): number {
    if (dispMax <= dispMin) return PH / 2;
    return (((dispMax - p) / (dispMax - dispMin)) * PH + 0.5) | 0;
  }

  y2p(y: number, dispMin: number, dispMax: number, plotH: number): number {
    if (dispMax <= dispMin) return dispMin;
    return dispMax - (dispMax - dispMin) * (y / plotH);
  }

  fmtAxisT(ms: number, tf: string): string {
    this.axisDate.setTime(ms);
    const d = this.axisDate;
    if (tf === '1W' || tf === '1D') {
      return MONTHS[d.getMonth()] + ' ' + d.getDate() + " '" + String(d.getFullYear()).slice(2);
    }
    if (tf === '4h') {
      return this.pad(d.getMonth() + 1) + '/' + this.pad(d.getDate()) + ' ' + this.pad(d.getHours()) + ':00';
    }
    if (tf === '1h' || tf === '30m' || tf === '15m') {
      return (
        this.pad(d.getMonth() + 1) +
        '/' +
        this.pad(d.getDate()) +
        ' ' +
        this.pad(d.getHours()) +
        ':' +
        this.pad(d.getMinutes())
      );
    }
    return this.pad(d.getHours()) + ':' + this.pad(d.getMinutes());
  }

  fmtCrossT(ms: number, tf: string): string {
    const d = new Date(ms);
    if (tf === '1W' || tf === '1D') {
      return d.getFullYear() + '-' + this.pad(d.getMonth() + 1) + '-' + this.pad(d.getDate());
    }
    return (
      this.pad(d.getMonth() + 1) +
      '/' +
      this.pad(d.getDate()) +
      ' ' +
      this.pad(d.getHours()) +
      ':' +
      this.pad(d.getMinutes()) +
      ':' +
      this.pad(d.getSeconds())
    );
  }

  /** Plot area only — sits under WebGL (z0). */
  drawPlotGrid(
    ctx: CanvasRenderingContext2D,
    L: ChartOverlayLayout,
    dispMin: number,
    dispMax: number,
    visStart: number,
    visEnd: number,
    candleSnapshotBuffer: Float64Array,
    candleSnapshotCount: number,
    _cf: number,
    _tf: string,
  ): void {
    const { W, H, PW, PH, DPR } = L;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#06060b';
    ctx.fillRect(0, 0, PW, PH);

    if (dispMin > 0 && dispMax > dispMin) {
      const range = dispMax - dispMin;
      const fontSize = 10 * DPR;
      const minGap = fontSize * 3.5;
      const step = this.niceStep(range, Math.max(3, Math.floor(PH / minGap)));
      const first = Math.ceil(dispMin / step) * step;
      ctx.strokeStyle = '#10101a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let p = first; p <= dispMax; p += step) {
        const y = this.p2y(p, dispMin, dispMax, PH);
        if (y < 4 || y > PH - 4) continue;
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(PW, y + 0.5);
      }
      ctx.stroke();
    }

    const vLen = visEnd - visStart;
    if (candleSnapshotCount > 0 && vLen > 0) {
      const xStep = PW / vLen;
      const cStep = Math.max(1, Math.ceil(vLen / Math.max(2, Math.floor(PW / (100 * DPR)))));
      ctx.strokeStyle = '#10101a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let ci = cStep; ci < vLen - 1; ci += cStep) {
        const di = visStart + ci;
        if (di < 0 || di >= candleSnapshotCount) continue;
        const x = (ci * xStep + xStep * 0.5 + 0.5) | 0;
        if (x < 30 * DPR || x > PW - 30 * DPR) continue;
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, PH);
      }
      ctx.stroke();
    }
  }

  /** Price + time axes — always on top canvas (MMT.gg margins). */
  drawAxisChrome(
    ctx: CanvasRenderingContext2D,
    L: ChartOverlayLayout,
    dispMin: number,
    dispMax: number,
    visStart: number,
    visEnd: number,
    candleSnapshotBuffer: Float64Array,
    candleSnapshotCount: number,
    _cf: number,
    _tf: string,
  ): void {
    const { W, H, PW, PH, DPR } = L;

    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(PW, 0, L.MR * DPR, H);
    ctx.fillRect(0, PH, W, L.MB * DPR);

    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PW + 0.5, 0);
    ctx.lineTo(PW + 0.5, H);
    ctx.moveTo(0, PH + 0.5);
    ctx.lineTo(W, PH + 0.5);
    ctx.stroke();

    if (dispMin > 0 && dispMax > dispMin) {
      const range = dispMax - dispMin;
      const fontSize = 10 * DPR;
      const minGap = fontSize * 3.5;
      const step = this.niceStep(range, Math.max(3, Math.floor(PH / minGap)));
      const first = Math.ceil(dispMin / step) * step;
      ctx.font = `${fontSize}px ${FONT}`;
      ctx.fillStyle = '#9aa8b8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let lastLabelY = Infinity;
      for (let p = first; p <= dispMax; p += step) {
        const y = this.p2y(p, dispMin, dispMax, PH);
        if (y < 4 || y > PH - 4) continue;
        if (lastLabelY - y < fontSize * 1.8) continue;
        ctx.fillText(this.fmtPrice(p), PW + 8 * DPR, y);
        lastLabelY = y;
      }
    }

    const vLen = visEnd - visStart;
    if (candleSnapshotCount > 0 && vLen > 0) {
      const xStep = PW / vLen;
      const cStep = Math.max(1, Math.ceil(vLen / Math.max(2, Math.floor(PW / (100 * DPR)))));
      ctx.font = `${9 * DPR}px ${FONT}`;
      ctx.fillStyle = '#7a8a9a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let ci = cStep; ci < vLen - 1; ci += cStep) {
        const di = visStart + ci;
        if (di < 0 || di >= candleSnapshotCount) continue;
        const x = (ci * xStep + xStep * 0.5 + 0.5) | 0;
        if (x < 30 * DPR || x > PW - 30 * DPR) continue;
        ctx.fillText(this.fmtAxisT(candleSnapshotBuffer[di * cf], tf), x, PH + 16 * DPR);
      }
    }
  }

  drawCrosshair(
    ctx: CanvasRenderingContext2D,
    L: ChartOverlayLayout,
    opts: {
      midPrice: number;
      dispMin: number;
      dispMax: number;
      crossOn: boolean;
      crosshairMouseXPixels: number;
      crosshairMouseYPixels: number;
      crossPLabel: string;
      crossTLabel: string;
      vwapLabels: VwapAxisLabel[];
      lastBarX: number;
    },
  ): void {
    const { PW, PH, DPR } = L;

    if (opts.midPrice > 0 && opts.dispMin > 0 && opts.dispMax > opts.dispMin) {
      const my = this.p2y(opts.midPrice, opts.dispMin, opts.dispMax, PH);
      if (my > 0 && my < PH) {
        ctx.strokeStyle = '#f0c14b';
        ctx.lineWidth = 1;
        ctx.setLineDash([2 * DPR, 2 * DPR]);
        ctx.beginPath();
        ctx.moveTo(0, my);
        ctx.lineTo(PW, my);
        ctx.stroke();
        ctx.setLineDash([]);
        const lbl = this.fmtPrice(opts.midPrice);
        ctx.font = `bold ${9 * DPR}px ${FONT}`;
        const tw = ctx.measureText(lbl).width + 10 * DPR;
        const lh = 16 * DPR;
        ctx.fillStyle = '#f0c14b';
        this.rrect(ctx, PW + 1, my - lh * 0.5, tw, lh, 2 * DPR);
        ctx.fill();
        ctx.fillStyle = '#06060b';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(lbl, PW + 5 * DPR, my);
      }
    }

    if (opts.dispMin > 0 && opts.dispMax > opts.dispMin) {
      let badgeY = 0;
      for (const v of opts.vwapLabels) {
        if (!v.on || v.price <= 0) continue;
        let vy = this.p2y(v.price, opts.dispMin, opts.dispMax, PH);
        if (vy < 2 || vy > PH - 2) continue;
        if (badgeY > 0 && Math.abs(vy - badgeY) < 16 * DPR) vy = badgeY + 16 * DPR;
        badgeY = vy;
        const x0 = opts.lastBarX;
        if (x0 < PW - 4 * DPR) {
          ctx.strokeStyle = v.color;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1;
          ctx.setLineDash([4 * DPR, 3 * DPR]);
          ctx.beginPath();
          ctx.moveTo(x0, vy);
          ctx.lineTo(PW, vy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.font = `bold ${8 * DPR}px ${FONT}`;
        const tw = ctx.measureText(v.text).width + 10 * DPR;
        const lh = 14 * DPR;
        ctx.fillStyle = v.color;
        this.rrect(ctx, PW + 1, vy - lh * 0.5, tw, lh, 2 * DPR);
        ctx.fill();
        ctx.fillStyle = v.fg;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.text, PW + 5 * DPR, vy);
      }
    }

    if (!opts.crossOn) return;
    const xP = opts.crosshairMouseXPixels * DPR;
    const yP = opts.crosshairMouseYPixels * DPR;
    if (xP > PW || yP > PH) return;

    ctx.setLineDash([3 * DPR, 3 * DPR]);
    ctx.strokeStyle = '#5a7a9a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yP);
    ctx.lineTo(PW, yP);
    ctx.moveTo(xP, 0);
    ctx.lineTo(xP, PH);
    ctx.stroke();
    ctx.setLineDash([]);

    if (opts.crossPLabel) {
      ctx.font = `${9 * DPR}px ${FONT}`;
      const tw = ctx.measureText(opts.crossPLabel).width + 10 * DPR;
      const lh = 16 * DPR;
      const lx = PW + 1;
      const ly = yP - lh * 0.5;
      ctx.fillStyle = '#1a2030';
      this.rrect(ctx, lx, ly, tw, lh, 2 * DPR);
      ctx.fill();
      ctx.strokeStyle = '#3a4a5a';
      ctx.lineWidth = 1;
      this.rrect(ctx, lx, ly, tw, lh, 2 * DPR);
      ctx.stroke();
      ctx.fillStyle = '#d0e0f0';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.crossPLabel, lx + 5 * DPR, yP);
    }
    if (opts.crossTLabel) {
      ctx.font = `${9 * DPR}px ${FONT}`;
      const tw = ctx.measureText(opts.crossTLabel).width + 12 * DPR;
      const th = 16 * DPR;
      const tx = xP - tw * 0.5;
      const ty = PH + 2 * DPR;
      ctx.fillStyle = '#1a2030';
      this.rrect(ctx, tx, ty, tw, th, 2 * DPR);
      ctx.fill();
      ctx.fillStyle = '#b0b8c0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.crossTLabel, xP, ty + th * 0.5);
    }
  }

  private niceStep(range: number, ticks: number): number {
    if (range <= 0 || ticks <= 0) return 1;
    const rough = range / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const n = rough / mag;
    return (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * mag;
  }

  private rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}
