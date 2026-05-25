/**
 * Workspace layout composable. Backs reactive widget state with a localStorage
 * snapshot so layouts survive reloads. One instance shared per page.
 */
import { ref, shallowReactive, watch } from 'vue';
import type { WidgetRect, WidgetState, WidgetType, WorkspaceLayout } from './types';
import { getWidget } from './registry';
import { busEmit } from './widgetBus';

const STORAGE_KEY = 'mmt-workspace-v1';
const LAYOUT_VERSION = 4;
/** Grid step in CSS pixels. Snap targets are integer multiples. */
export const CELL_PX = 8;

interface WorkspaceStore {
  widgets: WidgetState[];
  topZ: number;
}

const store = shallowReactive<WorkspaceStore>({ widgets: [], topZ: 1 });
/** Last chart widget that received focus (ChartTopBar edits this pane). */
export const activeChartId = ref<string | null>(null);

const hydrated = ref(false);
let nextSerial = 1;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const WIDGET_TYPES = new Set(['chart', 'orderflow-ladder', 'bar-stats', 'script-indicator-pane']);

function sanitizeWidget(w: WidgetState): WidgetState | null {
  if (!w || typeof w.id !== 'string' || !WIDGET_TYPES.has(w.type)) return null;
  const rect = w.rect;
  if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number') return null;
  return {
    id: w.id,
    type: w.type,
    rect: {
      x: rect.x | 0,
      y: rect.y | 0,
      w: Math.max(12, rect.w | 0),
      h: Math.max(10, rect.h | 0),
    },
    z: w.z | 0,
    props: w.props && typeof w.props === 'object' ? w.props : {},
  };
}

function safeLoad(): WorkspaceLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as WorkspaceLayout;
    if (!j || j.version !== LAYOUT_VERSION || !Array.isArray(j.widgets)) return null;
    const widgets = j.widgets.map(sanitizeWidget).filter(Boolean) as WidgetState[];
    if (!widgets.length) return null;
    return { ...j, widgets };
  } catch { return null; }
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snap: WorkspaceLayout = {
      version: LAYOUT_VERSION,
      widgets: store.widgets.map((w) => ({
        id: w.id, type: w.type, rect: { ...w.rect }, z: w.z, props: w.props,
      })),
      nextSerial,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)); } catch { /* quota — give up silently */ }
    busEmit({ type: 'workspace:dirty' });
  }, 250);
}

watch(() => store.widgets.length, scheduleSave);

export function useWorkspace() {
  if (!hydrated.value) {
    const loaded = safeLoad();
    if (loaded) {
      store.widgets = loaded.widgets;
      nextSerial = Math.max(1, loaded.nextSerial | 0);
      store.topZ = loaded.widgets.reduce((acc, w) => Math.max(acc, w.z | 0), 1);
    }
    hydrated.value = true;
  }

  function addWidget(type: WidgetType, rect?: Partial<WidgetRect>, props?: Record<string, unknown>): WidgetState | null {
    const reg = getWidget(type);
    if (!reg) return null;
    const id = `${type}-${nextSerial++}`;
    store.topZ++;
    const w: WidgetState = {
      id,
      type,
      rect: {
        x: rect?.x ?? 4,
        y: rect?.y ?? 4,
        w: rect?.w ?? reg.defaultSize.w,
        h: rect?.h ?? reg.defaultSize.h,
      },
      z: store.topZ,
      props: { ...reg.defaultProps(), ...(props ?? {}) },
    };
    store.widgets = [...store.widgets, w];
    scheduleSave();
    return w;
  }

  function removeWidget(id: string): void {
    store.widgets = store.widgets.filter((w) => w.id !== id);
    scheduleSave();
  }

  function updateRect(id: string, rect: WidgetRect): void {
    const idx = store.widgets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const w = store.widgets[idx];
    if (w.rect.x === rect.x && w.rect.y === rect.y && w.rect.w === rect.w && w.rect.h === rect.h) return;
    store.widgets[idx] = { ...w, rect };
    // Re-assign array so shallowReactive triggers downstream watchers
    store.widgets = store.widgets.slice();
    scheduleSave();
  }

  function bringToFront(id: string): void {
    const idx = store.widgets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    store.topZ++;
    store.widgets[idx] = { ...store.widgets[idx], z: store.topZ };
    store.widgets = store.widgets.slice();
    scheduleSave();
  }

  function updateProps(id: string, patch: Record<string, unknown>): void {
    const idx = store.widgets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const w = store.widgets[idx];
    store.widgets[idx] = { ...w, props: { ...w.props, ...patch } };
    store.widgets = store.widgets.slice();
    scheduleSave();
  }

  function ensureDefaults(defaults: { type: WidgetType; rect: WidgetRect; props?: Record<string, unknown> }[]): void {
    if (store.widgets.length > 0) return;
    for (const d of defaults) addWidget(d.type, d.rect, d.props);
  }

  /**
   * Fits the existing layout into a target viewport (in CSS pixels). Called
   * once after mount so the default cell-grid coordinates auto-scale to the
   * actual workspace canvas without falling off the right edge.
   */
  function fitToViewport(widthCssPx: number, heightCssPx: number, designW = 1664, designH = 800): void {
    if (widthCssPx <= 0 || heightCssPx <= 0) return;
    const sx = widthCssPx / designW;
    const sy = heightCssPx / designH;
    let changed = false;
    const next = store.widgets.map((w) => {
      const x = Math.max(0, Math.round(w.rect.x * sx));
      const y = Math.max(0, Math.round(w.rect.y * sy));
      const wCells = Math.max(12, Math.round(w.rect.w * sx));
      const hCells = Math.max(10, Math.round(w.rect.h * sy));
      if (x !== w.rect.x || y !== w.rect.y || wCells !== w.rect.w || hCells !== w.rect.h) {
        changed = true;
        return { ...w, rect: { x, y, w: wCells, h: hCells } };
      }
      return w;
    });
    if (changed) {
      store.widgets = next;
      scheduleSave();
    }
  }

  function resetWorkspace(): void {
    store.widgets = [];
    nextSerial = 1;
    store.topZ = 1;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  /**
   * Find the next free top-left corner for a new widget of the given size,
   * relative to the current viewport. Walks the grid in 4-cell steps and
   * returns the first slot whose rectangle does not overlap any existing
   * widget. Falls back to `(0, 0)` if nothing fits — the user can drag.
   */
  function findFreeSlot(
    desiredW: number,
    desiredH: number,
    viewportWCells: number,
    viewportHCells: number,
  ): { x: number; y: number } {
    const overlaps = (x: number, y: number) => {
      for (const w of store.widgets) {
        if (x + desiredW <= w.rect.x) continue;
        if (y + desiredH <= w.rect.y) continue;
        if (x >= w.rect.x + w.rect.w) continue;
        if (y >= w.rect.y + w.rect.h) continue;
        return true;
      }
      return false;
    };
    // Scan column-major from the right edge inward — the user expects new
    // widgets to dock on the right, not on top of the chart.
    for (let x = Math.max(0, viewportWCells - desiredW); x >= 0; x -= 4) {
      for (let y = 0; y + desiredH <= viewportHCells; y += 4) {
        if (!overlaps(x, y)) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  return {
    store,
    activeChartId,
    addWidget,
    removeWidget,
    updateRect,
    updateProps,
    bringToFront,
    ensureDefaults,
    fitToViewport,
    resetWorkspace,
    findFreeSlot,
  };
}
