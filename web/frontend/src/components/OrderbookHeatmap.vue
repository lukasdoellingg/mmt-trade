<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';

const props = defineProps({
  bids: { type: Array, default: () => [] },
  asks: { type: Array, default: () => [] },
  symbol: { type: String, default: '' },
});

const canvasRef = ref();
const history = ref([]);
const MAX_HISTORY = 150;
const POLL_MS = 5000;
let pollTimer = null;

const BIDS_COLOR_LO = [61, 201, 133];   // Grün
const BIDS_COLOR_HI = [240, 193, 75];   // Gelb
const ASKS_COLOR = [239, 79, 96];       // Rot

function addSnapshot() {
  const bids = props.bids || [];
  const asks = props.asks || [];
  if (!bids.length && !asks.length) return;
  const t = Math.floor(Date.now() / 1000);
  history.value = [...history.value.slice(-MAX_HISTORY), { time: t, bids: [...bids], asks: [...asks] }];
  draw();
}

function draw() {
  const canvas = canvasRef.value;
  if (!canvas || !history.value.length) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const hist = history.value;
  const nTime = hist.length;
  if (nTime === 0) return;

  let minP = Infinity;
  let maxP = -Infinity;
  for (let i = 0; i < hist.length; i++) {
    const b = hist[i].bids;
    const a = hist[i].asks;
    if (b.length && Number(b[0][0]) < minP) minP = Number(b[0][0]);
    if (a.length && Number(a[0][0]) > maxP) maxP = Number(a[0][0]);
    if (b.length && Number(b[b.length - 1][0]) < minP) minP = Number(b[b.length - 1][0]);
    if (a.length && Number(a[a.length - 1][0]) > maxP) maxP = Number(a[a.length - 1][0]);
  }
  if (minP >= maxP) maxP = minP + 1;
  const priceRange = maxP - minP || 1;
  const nPriceBuckets = 80;
  const bucketSize = priceRange / nPriceBuckets;

  let maxBidVal = 1;
  let maxAskVal = 1;
  const grid = [];
  for (let ti = 0; ti < nTime; ti++) {
    const row = { bids: new Array(nPriceBuckets).fill(0), asks: new Array(nPriceBuckets).fill(0) };
    const snap = hist[ti];
    for (let i = 0; i < snap.bids.length; i++) {
      const p = Number(snap.bids[i][0]);
      const v = Number(snap.bids[i][1]) || 0;
      const bucket = Math.min(nPriceBuckets - 1, Math.floor((p - minP) / bucketSize));
      if (bucket >= 0) {
        row.bids[bucket] += p * v;
        if (row.bids[bucket] > maxBidVal) maxBidVal = row.bids[bucket];
      }
    }
    for (let i = 0; i < snap.asks.length; i++) {
      const p = Number(snap.asks[i][0]);
      const v = Number(snap.asks[i][1]) || 0;
      const bucket = Math.min(nPriceBuckets - 1, Math.max(0, Math.floor((p - minP) / bucketSize)));
      row.asks[bucket] += p * v;
      if (row.asks[bucket] > maxAskVal) maxAskVal = row.asks[bucket];
    }
    grid.push(row);
  }

  const cellW = width / nTime;
  const cellH = height / nPriceBuckets;

  for (let ti = 0; ti < nTime; ti++) {
    for (let pi = 0; pi < nPriceBuckets; pi++) {
      const bidVal = grid[ti].bids[pi];
      const askVal = grid[ti].asks[pi];
      const x = ti * cellW;
      const y = (nPriceBuckets - 1 - pi) * cellH;
      const cw = Math.max(1, cellW + 0.5);
      const ch = Math.max(1, cellH + 0.5);
      if (bidVal > 0) {
        const t = Math.min(1, bidVal / maxBidVal);
        const r = BIDS_COLOR_LO[0] + (BIDS_COLOR_HI[0] - BIDS_COLOR_LO[0]) * t;
        const g = BIDS_COLOR_LO[1] + (BIDS_COLOR_HI[1] - BIDS_COLOR_LO[1]) * t;
        const b = BIDS_COLOR_LO[2] + (BIDS_COLOR_HI[2] - BIDS_COLOR_LO[2]) * t;
        ctx.fillStyle = `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${0.4 + 0.5 * t})`;
        ctx.fillRect(x, y, cw, ch);
      }
      if (askVal > 0) {
        const t = Math.min(1, askVal / maxAskVal);
        ctx.fillStyle = `rgba(${ASKS_COLOR[0]},${ASKS_COLOR[1]},${ASKS_COLOR[2]},${0.4 + 0.5 * t})`;
        ctx.fillRect(x, y, cw, ch);
      }
    }
  }
}

let resizeObserver;
onMounted(() => {
  addSnapshot();
  pollTimer = setInterval(addSnapshot, POLL_MS);
  resizeObserver = new ResizeObserver(() => draw());
  nextTick(() => {
    if (canvasRef.value) resizeObserver.observe(canvasRef.value);
  });
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (resizeObserver && canvasRef.value) resizeObserver.unobserve(canvasRef.value);
});

watch([() => props.bids, () => props.asks], addSnapshot);
</script>

<template>
  <div class="ob-heatmap">
    <div class="ob-heatmap-title">OB Heatmap ({{ symbol || '—' }}) · Gelb/Grün = Gebote</div>
    <canvas ref="canvasRef" class="ob-heatmap-canvas"></canvas>
  </div>
</template>

<style scoped>
.ob-heatmap {
  background: #0f0f14;
  border: 1px solid #1e2a1e;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}
.ob-heatmap-title {
  padding: 6px 10px;
  font-size: 0.75rem;
  color: #8ab88a;
  background: #14141c;
  border-bottom: 1px solid #1e2a1e;
}
.ob-heatmap-canvas {
  width: 100%;
  height: 140px;
  display: block;
}
</style>
