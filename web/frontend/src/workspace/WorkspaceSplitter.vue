<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  axis: 'h' | 'v';
  ratio: number;
}>();

const emit = defineEmits<{ ratio: [number] }>();

let dragging = false;
let startPos = 0;
let startRatio = 0;
let parentSize = 0;
let rafId = 0;
let pendingRatio = 0;

function onPointerDown(ev: PointerEvent): void {
  ev.preventDefault();
  const el = ev.currentTarget as HTMLElement;
  el.setPointerCapture(ev.pointerId);
  const parent = el.parentElement;
  if (!parent) return;
  dragging = true;
  startRatio = props.ratio;
  if (props.axis === 'h') {
    startPos = ev.clientX;
    parentSize = parent.clientWidth;
  } else {
    startPos = ev.clientY;
    parentSize = parent.clientHeight;
  }
}

function flushRatio(): void {
  rafId = 0;
  emit('ratio', pendingRatio);
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging || parentSize <= 0) return;
  const delta = (props.axis === 'h' ? ev.clientX - startPos : ev.clientY - startPos) / parentSize;
  pendingRatio = Math.max(0.15, Math.min(0.85, startRatio + delta));
  if (!rafId) rafId = requestAnimationFrame(flushRatio);
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    emit('ratio', pendingRatio);
  }
  (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
}

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
  <div
    class="ws-splitter"
    :class="axis"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  ></div>
</template>

<style scoped>
.ws-splitter {
  background: #181822;
  z-index: 2;
  flex-shrink: 0;
}
.ws-splitter.h {
  width: 4px;
  height: 100%;
  cursor: col-resize;
}
.ws-splitter.v {
  height: 4px;
  width: 100%;
  cursor: row-resize;
}
.ws-splitter:hover {
  background: #2a3a50;
}
</style>
