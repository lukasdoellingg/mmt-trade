/**
 * Workspace layout composable. Backs reactive widget state with a localStorage
 * snapshot so layouts survive reloads. Supports heatmap and futures profiles
 * with separate storage keys; futures adds four layout slots.
 */
import { ref, shallowReactive, watch } from 'vue';
import type { WidgetRect, WidgetState, WidgetType, WorkspaceLayout, WorkspaceProfile } from './types';
import { getWidget } from './registry';
import { busEmit } from './widgetBus';
import { chartPaneUnregister } from '../app/chartObjectTree';
import { snapshotPaneSettings } from '../chart/chartPaneSettings';

const LEGACY_STORAGE_KEY = 'mmt-workspace-v1';
const HEATMAP_STORAGE_KEY = 'mmt-workspace-heatmap-v1';
const FUTURES_SLOT_KEY = 'mmt-futures-layout-slot';
const FUTURES_STORAGE_PREFIX = 'mmt-workspace-futures-v1-slot-';
const LAYOUT_VERSION = 4;
/** Grid step in CSS pixels. Snap targets are integer multiples. */
export const CELL_PX = 8;

const BASE_WIDGET_TYPES = new Set<string>([
  'chart',
  'orderflow-ladder',
  'bar-stats',
  'script-indicator-pane',
]);
const FUTURES_WIDGET_TYPES = new Set<string>([...BASE_WIDGET_TYPES, 'coin-scanner', 'futures-metric-pane']);

interface WorkspaceStore {
  widgets: WidgetState[];
  topZ: number;
}

interface ProfileRuntime {
  nextSerial: number;
  hydrated: boolean;
}

const store = shallowReactive<WorkspaceStore>({ widgets: [], topZ: 1 });
/** Last chart widget that received focus (ChartTopBar edits this pane). */
export const activeChartId = ref<string | null>(null);

export const activeWorkspaceProfile = ref<WorkspaceProfile>('heatmap');
export const activeLayoutSlot = ref<1 | 2 | 3 | 4>(1);

const profileRuntimes: Record<WorkspaceProfile, ProfileRuntime> = {
  heatmap: { nextSerial: 1, hydrated: false },
  futures: { nextSerial: 1, hydrated: false },
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function widgetTypesFor(profile: WorkspaceProfile): Set<string> {
  return profile === 'futures' ? FUTURES_WIDGET_TYPES : BASE_WIDGET_TYPES;
}

function storageKeyFor(profile: WorkspaceProfile, slot = activeLayoutSlot.value): string {
  if (profile === 'heatmap') return HEATMAP_STORAGE_KEY;
  return `${FUTURES_STORAGE_PREFIX}${slot}`;
}

function sanitizeWidget(w: WidgetState, profile: WorkspaceProfile): WidgetState | null {
  if (!w || typeof w.id !== 'string' || !widgetTypesFor(profile).has(w.type)) return null;
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

function migrateLegacyHeatmap(): void {
  try {
    if (localStorage.getItem(HEATMAP_STORAGE_KEY)) return;
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    localStorage.setItem(HEATMAP_STORAGE_KEY, raw);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function readLayoutSlot(): 1 | 2 | 3 | 4 {
  try {
    const n = Number(localStorage.getItem(FUTURES_SLOT_KEY));
    if (n >= 1 && n <= 4) return n as 1 | 2 | 3 | 4;
  } catch {
    /* ignore */
  }
  return 1;
}

function safeLoad(profile: WorkspaceProfile): WorkspaceLayout | null {
  migrateLegacyHeatmap();
  try {
    const raw = localStorage.getItem(storageKeyFor(profile));
    if (!raw) return null;
    const j = JSON.parse(raw) as WorkspaceLayout;
    if (!j || j.version !== LAYOUT_VERSION || !Array.isArray(j.widgets)) return null;
    const widgets = j.widgets.map((w) => sanitizeWidget(w, profile)).filter(Boolean) as WidgetState[];
    if (!widgets.length) return null;
    return { ...j, widgets };
  } catch {
    return null;
  }
}

function flushSave(profile = activeWorkspaceProfile.value): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const rt = profileRuntimes[profile];
  const snap: WorkspaceLayout = {
    version: LAYOUT_VERSION,
    widgets: store.widgets.map((w) => ({
      id: w.id,
      type: w.type,
      rect: { ...w.rect },
      z: w.z,
      props: w.props,
    })),
    nextSerial: rt.nextSerial,
  };
  try {
    localStorage.setItem(storageKeyFor(profile), JSON.stringify(snap));
  } catch {
    /* quota */
  }
  busEmit({ type: 'workspace:dirty' });
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, 250);
}

watch(() => store.widgets.length, scheduleSave);

function hydrateProfile(profile: WorkspaceProfile, force = false): void {
  const rt = profileRuntimes[profile];
  if (rt.hydrated && !force) return;
  const loaded = safeLoad(profile);
  if (loaded) {
    store.widgets = loaded.widgets;
    rt.nextSerial = Math.max(1, loaded.nextSerial | 0);
    store.topZ = loaded.widgets.reduce((acc, w) => Math.max(acc, w.z | 0), 1);
  } else {
    store.widgets = [];
    rt.nextSerial = 1;
    store.topZ = 1;
  }
  activeChartId.value =
    [...store.widgets].reverse().find((w) => w.type === 'chart')?.id ?? null;
  rt.hydrated = true;
}

/** Switch active workspace profile (heatmap desk vs futures desk). */
export function setWorkspaceProfile(profile: WorkspaceProfile): void {
  if (activeWorkspaceProfile.value === profile && profileRuntimes[profile].hydrated) return;
  if (profileRuntimes[activeWorkspaceProfile.value].hydrated) {
    flushSave(activeWorkspaceProfile.value);
  }
  activeWorkspaceProfile.value = profile;
  if (profile === 'futures') {
    activeLayoutSlot.value = readLayoutSlot();
  }
  hydrateProfile(profile, true);
}

/** Futures-only: switch layout slot 1–4 (persists widgets per slot). */
export function switchLayoutSlot(slot: 1 | 2 | 3 | 4): void {
  if (activeWorkspaceProfile.value !== 'futures' || activeLayoutSlot.value === slot) return;
  flushSave('futures');
  activeLayoutSlot.value = slot;
  try {
    localStorage.setItem(FUTURES_SLOT_KEY, String(slot));
  } catch {
    /* ignore */
  }
  profileRuntimes.futures.hydrated = false;
  hydrateProfile('futures', true);
}

export function useWorkspace() {
  if (!profileRuntimes[activeWorkspaceProfile.value].hydrated) {
    if (activeWorkspaceProfile.value === 'futures') {
      activeLayoutSlot.value = readLayoutSlot();
    }
    hydrateProfile(activeWorkspaceProfile.value);
  }

  function addWidget(
    type: WidgetType,
    rect?: Partial<WidgetRect>,
    props?: Record<string, unknown>,
  ): WidgetState | null {
    const reg = getWidget(type);
    if (!reg) return null;
    const rt = profileRuntimes[activeWorkspaceProfile.value];
    const id = `${type}-${rt.nextSerial++}`;
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
    if (!store.widgets.some((w) => w.id === id)) return;
    store.widgets = store.widgets.filter((w) => w.id !== id);
    scheduleSave();
  }

  function closeChartWidget(chartId: string): void {
    const chart = store.widgets.find((w) => w.id === chartId && w.type === 'chart');
    if (!chart) return;

    const removeIds = new Set<string>([chartId]);
    for (const w of store.widgets) {
      if (w.type !== 'script-indicator-pane') continue;
      const parent = (w.props as { parentChartWidgetId?: string })?.parentChartWidgetId;
      if (parent === chartId) removeIds.add(w.id);
    }

    if (activeChartId.value === chartId) {
      const remaining = store.widgets.filter((w) => w.type === 'chart' && !removeIds.has(w.id));
      activeChartId.value = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    }

    for (const id of removeIds) {
      const w = store.widgets.find((x) => x.id === id);
      if (w) snapshotPaneSettings(id, w.props as Record<string, unknown>);
    }

    chartPaneUnregister(chartId);
    store.widgets = store.widgets.filter((w) => !removeIds.has(w.id));
    scheduleSave();
  }

  function updateRect(id: string, rect: WidgetRect): void {
    const idx = store.widgets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const w = store.widgets[idx];
    if (w.rect.x === rect.x && w.rect.y === rect.y && w.rect.w === rect.w && w.rect.h === rect.h) return;
    store.widgets[idx] = { ...w, rect };
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
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (w.props[k] !== v) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    store.widgets[idx] = { ...w, props: { ...w.props, ...patch } };
    store.widgets = store.widgets.slice();
    scheduleSave();
  }

  function ensureDefaults(
    defaults: { type: WidgetType; rect: WidgetRect; props?: Record<string, unknown> }[],
  ): void {
    if (store.widgets.length > 0) return;
    for (const d of defaults) addWidget(d.type, d.rect, d.props);
  }

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
    const rt = profileRuntimes[activeWorkspaceProfile.value];
    rt.nextSerial = 1;
    store.topZ = 1;
    activeChartId.value = null;
    try {
      localStorage.removeItem(storageKeyFor(activeWorkspaceProfile.value));
    } catch {
      /* ignore */
    }
  }

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
    activeWorkspaceProfile,
    activeLayoutSlot,
    addWidget,
    removeWidget,
    closeChartWidget,
    updateRect,
    updateProps,
    bringToFront,
    ensureDefaults,
    fitToViewport,
    resetWorkspace,
    findFreeSlot,
    switchLayoutSlot,
    setWorkspaceProfile,
  };
}
