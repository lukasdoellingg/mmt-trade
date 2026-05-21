<script setup lang="ts">
/**
 * mmt.gg-style vertical tool rail on the left edge of the workspace.
 *
 * `cursor`, `crosshair`, `pencil` drive `settings.tool` (shared with the
 * chart widget). `refresh` resets the workspace layout; `settings` opens
 * the global settings modal. The remaining icons are stubs awaiting a
 * dedicated tool implementation (search palette, layer manager, drawing
 * shapes/eraser); they highlight on click but produce no chart effect yet.
 */
import { useChartSettings, type ChartTool } from '../../chart/chartSettings';
import { useWorkspace } from '../../workspace/useWorkspace';

const settings = useChartSettings();
const { resetWorkspace } = useWorkspace();

function pick(t: ChartTool) {
  settings.tool = t;
}
function onRefresh() {
  if (window.confirm('Reset workspace layout? Your widget positions will be lost.')) resetWorkspace();
}
function openSettings() {
  settings.settingsModalOpen = true;
}
function isOn(t: ChartTool) {
  return settings.tool === t;
}
function showShortcuts() {
  window.alert(
    'Keyboard shortcuts:\n' +
      '  Mouse wheel — Zoom\n' +
      '  Click + drag — Pan\n' +
      '  Double-click — Reset view\n' +
      '  Shift + wheel — Horizontal scroll',
  );
}
</script>

<template>
  <div class="rail">
    <button
      class="rail-btn"
      :class="{ on: isOn('cursor') }"
      title="Cursor (pan only, no crosshair)"
      @click="pick('cursor')"
    >
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="currentColor" d="M3 2l10 5-4 1-1.5 4z" />
      </svg>
    </button>
    <button class="rail-btn" :class="{ on: isOn('crosshair') }" title="Crosshair" @click="pick('crosshair')">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 1v14M1 8h14" />
      </svg>
    </button>
    <span class="rail-sep"></span>
    <button class="rail-btn" title="Search (coming soon)" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path stroke="currentColor" stroke-width="1.4" d="M10.5 10.5L14 14" />
      </svg>
    </button>
    <button class="rail-btn" title="Layers (coming soon)" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="currentColor" d="M8 1l7 3-7 3-7-3zM1 8l7 3 7-3M1 11l7 3 7-3" />
      </svg>
    </button>
    <button class="rail-btn" :class="{ on: isOn('pencil') }" title="Drawing tool" @click="pick('pencil')">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="currentColor" d="M13 2l1 1-9 9-2 .5L3.5 11z" />
      </svg>
    </button>
    <button class="rail-btn" title="Shapes (coming soon)" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14">
        <rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.3" />
        <circle cx="11" cy="11" r="3.2" fill="none" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
    <button class="rail-btn" title="Eraser (coming soon)" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="currentColor" d="M3 13h10v-1H3zM4 11l5-7 4 3-5 7z" />
      </svg>
    </button>
    <span class="rail-sep"></span>
    <button class="rail-btn" title="Reset workspace layout" @click="onRefresh">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="none" stroke="currentColor" stroke-width="1.3" d="M2 8a6 6 0 0 1 10.5-3.8" />
        <path fill="currentColor" d="M12 1l1 3.5-3.5.5z" />
      </svg>
    </button>
    <button class="rail-btn" title="Help / Keyboard shortcuts" @click="showShortcuts">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path fill="currentColor" d="M7 6c0-1 1-1.5 1.7-1.5C9.5 4.5 10 5 10 6c0 1.5-2 1-2 3M7 11h2v1H7z" />
      </svg>
    </button>
    <span class="rail-spacer"></span>
    <button class="rail-btn" title="Settings" @click="openSettings">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path
          fill="currentColor"
          d="M8 5a3 3 0 1 0 3 3 3 3 0 0 0-3-3zm6 3-1-.5.3-1.4-1.2-1.2L11 5.4 10.4 4 9 3.7 7 3.7 5.6 4 5 5.4l-1.1-.5L2.7 6.1 3 7.5 2 8l1 .5-.3 1.4 1.2 1.2 1.1-.5L5.6 12l1.4.3h2L10.4 12l.6-1.4 1.1.5 1.2-1.2L13 8.5z"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.rail {
  width: 34px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: #08080d;
  border-right: 1px solid #15151f;
  padding: 6px 0;
  flex-shrink: 0;
  gap: 2px;
}
.rail-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  color: #5a6878;
  cursor: pointer;
  border-radius: 3px;
  transition:
    color 0.12s,
    background 0.12s,
    border-color 0.12s;
}
.rail-btn:hover:not(:disabled) {
  color: #cad8e8;
  background: #15151f;
}
.rail-btn.on {
  color: #3dc985;
  background: #0d1812;
  border-color: #1a3525;
}
.rail-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.rail-sep {
  width: 18px;
  height: 1px;
  background: #1a1a26;
  margin: 4px 0;
  flex-shrink: 0;
}
.rail-spacer {
  flex: 1;
}
</style>
