<script setup lang="ts">
/**
 * Tab stack chrome — multiple pane anchors share one rect (LCM Phase 2).
 */
import { computed } from 'vue';
import type { TabGroupState, WidgetState } from './types';
import { CELL_PX, useWorkspace } from './useWorkspace';
import { getWidget } from './registry';
import { suspendLease, resumeLease, setFocusAnchor } from './runtimeLockRegistry';

const props = defineProps<{
  group: TabGroupState;
  members: WidgetState[];
}>();

const emit = defineEmits<{ select: [anchorId: string] }>();

const { setTabGroupActive, bringTabGroupToFront, updateRect } = useWorkspace();

const style = computed(() => ({
  left: props.group.rect.x * CELL_PX + 'px',
  top: props.group.rect.y * CELL_PX + 'px',
  width: props.group.rect.w * CELL_PX + 'px',
  height: props.group.rect.h * CELL_PX + 'px',
  zIndex: String(props.group.z),
}));

function labelFor(w: WidgetState): string {
  const reg = getWidget(w.type);
  const base = reg?.label ?? w.type;
  const p = w.props as Record<string, unknown>;
  if (w.type === 'chart' && p.symbol) return String(p.symbol).toLowerCase();
  return base;
}

function onTabClick(anchorId: string): void {
  if (anchorId === props.group.activeAnchorId) return;
  suspendLease(props.group.activeAnchorId);
  setTabGroupActive(props.group.groupId, anchorId);
  resumeLease(anchorId);
  setFocusAnchor(anchorId);
  emit('select', anchorId);
}

function onPointerDown(): void {
  bringTabGroupToFront(props.group.groupId);
}

interface ResizeState {
  pointerId: number;
  startX: number;
  startY: number;
  startRect: { x: number; y: number; w: number; h: number };
}
let resize: ResizeState | null = null;

function onResizeDown(ev: PointerEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  resize = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    startRect: { ...props.group.rect },
  };
}

function onResizeMove(ev: PointerEvent): void {
  if (!resize || ev.pointerId !== resize.pointerId) return;
  const dx = Math.round((ev.clientX - resize.startX) / CELL_PX);
  const dy = Math.round((ev.clientY - resize.startY) / CELL_PX);
  const member = props.members.find((m) => m.anchorId === props.group.activeAnchorId);
  if (!member) return;
  updateRect(member.id, {
    x: resize.startRect.x,
    y: resize.startRect.y,
    w: Math.max(12, resize.startRect.w + dx),
    h: Math.max(10, resize.startRect.h + dy),
  });
}

function onResizeUp(ev: PointerEvent): void {
  if (resize && ev.pointerId === resize.pointerId) resize = null;
}
</script>

<template>
  <div class="ws-tabstack" :style="style" @pointerdown="onPointerDown">
    <header class="ws-tab-head">
      <button
        v-for="w in members"
        :key="w.anchorId"
        type="button"
        class="ws-tab"
        :class="{ active: w.anchorId === group.activeAnchorId }"
        @click.stop="onTabClick(w.anchorId)"
      >
        {{ labelFor(w) }}
      </button>
    </header>
    <div class="ws-tab-body">
      <slot />
      <span
        class="ws-tab-resize"
        @pointerdown="onResizeDown"
        @pointermove="onResizeMove"
        @pointerup="onResizeUp"
        @pointercancel="onResizeUp"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.ws-tabstack {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: #0a0a10;
  border: 1px solid #1a1a28;
  border-radius: 4px;
  overflow: hidden;
  contain: layout paint;
}
.ws-tab-head {
  display: flex;
  gap: 2px;
  height: 24px;
  flex-shrink: 0;
  padding: 0 4px;
  background: #0e0e16;
  border-bottom: 1px solid #181822;
}
.ws-tab {
  background: transparent;
  border: none;
  color: #5a6878;
  font: 600 11px/1 Consolas, monospace;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 2px 2px 0 0;
}
.ws-tab.active {
  color: #cad8e8;
  background: #15151f;
}
.ws-tab-body {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.ws-tab-resize {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 10px;
  height: 10px;
  cursor: nwse-resize;
  z-index: 6;
}
</style>
