<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetState } from './types';
import { CELL_PX, useWorkspace } from './useWorkspace';

const props = defineProps<{
  widget: WidgetState;
  title: string;
  /** Badge after title (e.g. "(9)" for aggregation count). */
  badge?: string;
  /** Hide the close button (e.g. for the always-present chart). */
  noClose?: boolean;
  /** Parent handles removal via @close (skip default removeWidget). */
  handleClose?: boolean;
  /** Hide all drag/resize affordances (locked widget). */
  locked?: boolean;
}>();

const emit = defineEmits<{ gear: []; link: []; close: [] }>();

const { removeWidget, updateRect, bringToFront } = useWorkspace();

const style = computed(() => ({
  left: props.widget.rect.x * CELL_PX + 'px',
  top: props.widget.rect.y * CELL_PX + 'px',
  width: props.widget.rect.w * CELL_PX + 'px',
  height: props.widget.rect.h * CELL_PX + 'px',
  zIndex: String(props.widget.z),
}));

interface DragState {
  pointerId: number;
  startX: number; startY: number;
  startRect: { x: number; y: number; w: number; h: number };
  mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
}
let drag: DragState | null = null;

const MIN_W = 12; // 96 px
const MIN_H = 10; // 80 px

function onDragDown(ev: PointerEvent) {
  if (props.locked) return;
  if ((ev.target as HTMLElement).closest('[data-no-drag]')) return;
  ev.preventDefault();
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  drag = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    startRect: { ...props.widget.rect },
    mode: 'move',
  };
  bringToFront(props.widget.id);
}

function onResizeDown(mode: DragState['mode'], ev: PointerEvent) {
  if (props.locked) return;
  ev.preventDefault();
  ev.stopPropagation();
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  drag = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    startRect: { ...props.widget.rect },
    mode,
  };
  bringToFront(props.widget.id);
}

function onPointerMove(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const dx = Math.round((ev.clientX - drag.startX) / CELL_PX);
  const dy = Math.round((ev.clientY - drag.startY) / CELL_PX);
  let { x, y, w, h } = drag.startRect;
  switch (drag.mode) {
    case 'move': x += dx; y += dy; break;
    case 'e':  w = Math.max(MIN_W, w + dx); break;
    case 'w':  { const nw = Math.max(MIN_W, w - dx); x += w - nw; w = nw; break; }
    case 's':  h = Math.max(MIN_H, h + dy); break;
    case 'n':  { const nh = Math.max(MIN_H, h - dy); y += h - nh; h = nh; break; }
    case 'se': w = Math.max(MIN_W, w + dx); h = Math.max(MIN_H, h + dy); break;
    case 'sw': { const nw = Math.max(MIN_W, w - dx); x += w - nw; w = nw; h = Math.max(MIN_H, h + dy); break; }
    case 'ne': { const nh = Math.max(MIN_H, h - dy); y += h - nh; h = nh; w = Math.max(MIN_W, w + dx); break; }
    case 'nw': { const nw = Math.max(MIN_W, w - dx); x += w - nw; w = nw; const nh = Math.max(MIN_H, h - dy); y += h - nh; h = nh; break; }
  }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  updateRect(props.widget.id, { x, y, w, h });
}

function onPointerUp(ev: PointerEvent) {
  if (drag && ev.pointerId === drag.pointerId) drag = null;
}

function onClose() {
  if (props.noClose) return;
  emit('close');
  if (!props.handleClose) removeWidget(props.widget.id);
}
</script>

<template>
  <div class="ws-widget" :style="style" @pointerdown="bringToFront(widget.id)">
    <header
      class="ws-head"
      @pointerdown="onDragDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <span class="ws-title">{{ title }}</span>
      <span v-if="badge" class="ws-badge">{{ badge }}</span>
      <span class="ws-spacer"></span>
      <button v-if="$slots.headerExtra" data-no-drag class="ws-head-slot"><slot name="headerExtra" /></button>
      <button data-no-drag class="ws-icon" title="Link group" @click.stop="emit('link')">&#128279;</button>
      <button data-no-drag class="ws-icon" title="Settings" @click.stop="emit('gear')">&#9881;</button>
      <button v-if="!noClose" data-no-drag class="ws-icon ws-close" title="Close" @click.stop="onClose">&times;</button>
    </header>
    <div class="ws-body">
      <slot />
    </div>
    <template v-if="!locked">
      <span class="ws-edge ws-e-n" @pointerdown="(e) => onResizeDown('n', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-e-s" @pointerdown="(e) => onResizeDown('s', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-e-e" @pointerdown="(e) => onResizeDown('e', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-e-w" @pointerdown="(e) => onResizeDown('w', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-c-ne" @pointerdown="(e) => onResizeDown('ne', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-c-nw" @pointerdown="(e) => onResizeDown('nw', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-c-se" @pointerdown="(e) => onResizeDown('se', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
      <span class="ws-edge ws-c-sw" @pointerdown="(e) => onResizeDown('sw', e)" @pointermove="onPointerMove" @pointerup="onPointerUp"></span>
    </template>
  </div>
</template>

<style scoped>
.ws-widget{
  position:absolute;display:flex;flex-direction:column;
  background:#0a0a10;border:1px solid #1a1a28;border-radius:4px;
  box-shadow:0 1px 0 #000;overflow:hidden;contain:layout paint;
}
.ws-head{
  display:flex;align-items:center;gap:6px;height:24px;flex-shrink:0;
  padding:0 4px 0 10px;background:#0e0e16;border-bottom:1px solid #181822;
  font:11px/1 Consolas,"Courier New",monospace;color:#aebcce;
  cursor:grab;user-select:none;
}
.ws-head:active{cursor:grabbing}
.ws-title{color:#cad8e8;font-weight:600;letter-spacing:.2px;text-transform:lowercase}
.ws-badge{color:#5a6878;font-weight:600;padding:1px 4px;background:#15151f;border-radius:2px}
.ws-spacer{flex:1}
.ws-icon{
  background:transparent;border:none;color:#5a6878;font:inherit;font-size:13px;
  width:22px;height:22px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;border-radius:2px;
}
.ws-icon:hover{color:#aebcce;background:#15151f}
.ws-close:hover{color:#ef4f60}
.ws-head-slot{background:transparent;border:none;padding:0;display:flex;align-items:center;color:#5a6878}
.ws-body{flex:1;min-height:0;overflow:hidden;position:relative;background:#06060b}
.ws-edge{position:absolute;background:transparent;z-index:5}
.ws-e-n{top:-3px;left:8px;right:8px;height:6px;cursor:ns-resize}
.ws-e-s{bottom:-3px;left:8px;right:8px;height:6px;cursor:ns-resize}
.ws-e-e{top:8px;bottom:8px;right:-3px;width:6px;cursor:ew-resize}
.ws-e-w{top:8px;bottom:8px;left:-3px;width:6px;cursor:ew-resize}
.ws-c-ne{top:-3px;right:-3px;width:10px;height:10px;cursor:nesw-resize}
.ws-c-nw{top:-3px;left:-3px;width:10px;height:10px;cursor:nwse-resize}
.ws-c-se{bottom:-3px;right:-3px;width:10px;height:10px;cursor:nwse-resize}
.ws-c-sw{bottom:-3px;left:-3px;width:10px;height:10px;cursor:nesw-resize}
</style>
