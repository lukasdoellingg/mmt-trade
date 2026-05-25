<script lang="ts">
import Highcharts from 'highcharts/highstock';
import { VELO_CHART } from '../../highchartsTheme';
import { debugWarn } from '../../utils/debug';

const BASE = Object.freeze(structuredClone(VELO_CHART));

function shallowMerge(target, src) {
  if (!src) return target;
  const out = { ...target };
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && sv.constructor === Object) {
      out[k] = shallowMerge(out[k] || {}, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

function seriesNeedsFullUpdate(series) {
  if (!series) return false;
  for (const s of series) {
    if (s.colorByPoint) return true;
    const d = s.data;
    if (!d || !d.length) continue;
    const p = d[0];
    if (p && typeof p === 'object' && !Array.isArray(p) && (p.color != null || p.x != null)) return true;
  }
  return false;
}

function pointDataFingerprint(data) {
  if (!data || !data.length) return 0;
  let fp = data.length;
  for (let i = 0; i < data.length; i++) {
    const p = data[i];
    if (Array.isArray(p)) {
      fp = (fp * 31 + (p[0] | 0)) | 0;
      fp = (fp * 31 + (((p[1] ?? 0) * 1000) | 0)) | 0;
    } else if (p && typeof p === 'object') {
      fp = (fp * 31 + ((p.x ?? 0) | 0)) | 0;
      fp = (fp * 31 + (((p.y ?? 0) * 1000) | 0)) | 0;
      if (p.color) fp = (fp * 31 + p.color.charCodeAt(0)) | 0;
    }
  }
  return fp;
}

function seriesDataEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i],
      sb = b[i];
    if (!sa || !sb) return false;
    if (sa.data?.length !== sb.data?.length) return false;
    if (sa.name !== sb.name || sa.color !== sb.color || sa.type !== sb.type) return false;
    if (sa.colorByPoint !== sb.colorByPoint) return false;
    if (pointDataFingerprint(sa.data) !== pointDataFingerprint(sb.data)) return false;
  }
  return true;
}
</script>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, watch, nextTick } from 'vue';

const props = defineProps({
  options: { type: Object, default: () => ({}) },
});

const el = ref(null);
let chart = null;
let ro = null;
let resizeRaf = 0;
let renderRaf = 0;
let prevSeries = null;

const merged = computed(() => {
  const m = shallowMerge(BASE, props.options);
  m.chart = { ...(m.chart || {}), renderTo: undefined };
  return m;
});

function render() {
  if (!el.value) return;
  const { width: w, height: h } = el.value.getBoundingClientRect();
  if (w < 10 || h < 10) return;
  const cw = Math.max(w, 100),
    ch = Math.max(h, 80);
  const opts = { ...merged.value, chart: { ...merged.value.chart, width: cw, height: ch } };

  try {
    if (chart) {
      const newSeries = opts.series || [];
      const onlyDataChanged =
        seriesDataEqual(prevSeries, newSeries) && !seriesNeedsFullUpdate(newSeries);

      if (onlyDataChanged && chart.series?.length === newSeries.length) {
        for (let i = 0; i < newSeries.length; i++) {
          chart.series[i].setData(newSeries[i].data || [], false, false, false);
        }
        chart.redraw(false);
      } else {
        chart.update(opts, true, true, false);
      }
      prevSeries = newSeries;
    } else {
      chart = Highcharts.chart(el.value, opts);
      prevSeries = opts.series || [];
    }
  } catch (e) {
    debugWarn('Highcharts render error:', e.message);
    if (chart) {
      try {
        chart.destroy();
      } catch {
        /* ignore */
      }
      chart = null;
    }
    try {
      chart = Highcharts.chart(el.value, opts);
      prevSeries = opts.series || [];
    } catch {
      /* give up */
    }
  }
}

function debouncedRender() {
  if (renderRaf) cancelAnimationFrame(renderRaf);
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    nextTick(render);
  });
}

function resize() {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (!el.value || !chart) return;
    const { width: w, height: h } = el.value.getBoundingClientRect();
    if (w < 10 || h < 10) return;
    try {
      chart.setSize(Math.max(w, 100), Math.max(h, 80), false);
    } catch {
      /* ignore */
    }
  });
}

onMounted(() => {
  nextTick(render);
  ro = new ResizeObserver(resize);
  if (el.value) ro.observe(el.value);
});

onUnmounted(() => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  if (renderRaf) cancelAnimationFrame(renderRaf);
  ro?.disconnect();
  try {
    chart?.destroy();
  } catch {
    /* ignore */
  }
  chart = null;
  prevSeries = null;
});

onActivated(() => {
  if (el.value && !chart) nextTick(render);
  else if (chart) nextTick(resize);
});

onDeactivated(() => {
  if (renderRaf) cancelAnimationFrame(renderRaf);
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
});

watch(merged, debouncedRender, { deep: false });
</script>

<template>
  <div ref="el" class="hc-el"></div>
</template>

<style scoped>
.hc-el {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
}
</style>
