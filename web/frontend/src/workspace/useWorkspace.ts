/**
 * Workspace layout composable — LCM v5 with anchor IDs, tab groups, layout catalog.
 */
import { computed, ref, shallowReactive, watch } from 'vue';
import type {
  LayoutDocument,
  RegionNode,
  TabGroupState,
  WidgetRect,
  WidgetState,
  WidgetType,
  WorkspaceProfile,
} from './types';
import {
  buildHeatmapDefaultTree,
  inferSplitFromWidgets,
  dockToEdge,
  mutateSplitRatio,
  splitLeaf,
  type DockEdge,
} from './layoutTree';
import { getWidget } from './registry';
import { busEmit } from './widgetBus';
import { chartPaneUnregister } from '../app/chartObjectTree';
import { snapshotPaneSettings } from '../chart/chartPaneSettings';
import {
  applyTabGroupVisibility,
  documentToWorkspaceLayout,
  ensureWidgetAnchor,
  layoutMetaFor,
  LAYOUT_DOC_VERSION,
  migrateWorkspaceLayoutToDocument,
  newAnchorId,
  parseLayoutDocument,
  parseLegacyWorkspaceLayout,
} from './layoutDocument';
import {
  focusAnchorId,
  releaseLease,
  resolveFocusedChartWidgetId,
  resumeSlot,
  setFocusAnchor,
  slotKeyFor,
  suspendSlot,
} from './runtimeLockRegistry';
import { saveLayoutToCatalog, getCatalogEntry } from './layoutCatalog';

const LEGACY_STORAGE_KEY = 'mmt-workspace-v1';
const LEGACY_HEATMAP_KEY = 'mmt-workspace-heatmap-v1';
const LEGACY_FUTURES_PREFIX = 'mmt-workspace-futures-v1-slot-';
const HEATMAP_STORAGE_KEY = 'mmt-layout-heatmap-v5';
const FUTURES_SLOT_KEY = 'mmt-futures-layout-slot';
const FUTURES_STORAGE_PREFIX = 'mmt-layout-futures-v5-slot-';

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
  tabGroups: TabGroupState[];
  topZ: number;
  focusAnchorId: string | null;
  /** CSS Grid split tree when set; null = legacy absolute float layout. */
  layoutRoot: RegionNode | null;
}

interface ProfileRuntime {
  nextSerial: number;
  hydrated: boolean;
  layoutDocument: LayoutDocument | null;
}

const store = shallowReactive<WorkspaceStore>({
  widgets: [],
  tabGroups: [],
  topZ: 1,
  focusAnchorId: null,
  layoutRoot: null,
});

/** When true, splitters and widget drag/resize are disabled. */
export const layoutLocked = ref(false);

/** Last focused chart widget id (derived from focusAnchorId). */
export const activeChartId = computed({
  get: () => resolveFocusedChartWidgetId(store.widgets),
  set: (widgetId: string | null) => {
    if (!widgetId) {
      setFocusAnchor(null);
      store.focusAnchorId = null;
      return;
    }
    const w = store.widgets.find((x) => x.id === widgetId);
    if (w) {
      setFocusAnchor(w.anchorId);
      store.focusAnchorId = w.anchorId;
    }
  },
});

export const activeWorkspaceProfile = ref<WorkspaceProfile>('heatmap');
export const activeLayoutSlot = ref<1 | 2 | 3 | 4>(1);

const profileRuntimes: Record<WorkspaceProfile, ProfileRuntime> = {
  heatmap: { nextSerial: 1, hydrated: false, layoutDocument: null },
  futures: { nextSerial: 1, hydrated: false, layoutDocument: null },
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function widgetTypesFor(profile: WorkspaceProfile): Set<string> {
  return profile === 'futures' ? FUTURES_WIDGET_TYPES : BASE_WIDGET_TYPES;
}

function storageKeyV5(profile: WorkspaceProfile, slot = activeLayoutSlot.value): string {
  if (profile === 'heatmap') return HEATMAP_STORAGE_KEY;
  return `${FUTURES_STORAGE_PREFIX}${slot}`;
}

function legacyStorageKey(profile: WorkspaceProfile, slot = activeLayoutSlot.value): string {
  if (profile === 'heatmap') return LEGACY_HEATMAP_KEY;
  return `${LEGACY_FUTURES_PREFIX}${slot}`;
}

function sanitizeWidget(w: WidgetState, profile: WorkspaceProfile): WidgetState | null {
  if (!w || typeof w.id !== 'string' || !widgetTypesFor(profile).has(w.type)) return null;
  const rect = w.rect;
  if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number') return null;
  const anchored = ensureWidgetAnchor(w);
  return {
    id: anchored.id,
    anchorId: anchored.anchorId,
    type: anchored.type,
    tabGroupId: anchored.tabGroupId,
    rect: {
      x: rect.x | 0,
      y: rect.y | 0,
      w: Math.max(12, rect.w | 0),
      h: Math.max(10, rect.h | 0),
    },
    z: anchored.z | 0,
    props: anchored.props && typeof anchored.props === 'object' ? anchored.props : {},
  };
}

function migrateLegacyHeatmapKey(): void {
  try {
    if (localStorage.getItem(LEGACY_HEATMAP_KEY) || localStorage.getItem(HEATMAP_STORAGE_KEY)) return;
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    localStorage.setItem(LEGACY_HEATMAP_KEY, raw);
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

function buildDocumentFromStore(profile: WorkspaceProfile): LayoutDocument {
  const rt = profileRuntimes[profile];
  const meta = layoutMetaFor(profile, activeLayoutSlot.value, rt.layoutDocument?.meta.name);
  const widgets = store.widgets.map((w) => ({ ...w, rect: { ...w.rect }, props: { ...w.props } }));
  const anchors = { ...(rt.layoutDocument?.anchors ?? {}) };
  const bindings = [...(rt.layoutDocument?.bindings ?? [])];

  for (const w of widgets) {
    if (!anchors[w.anchorId]) {
      anchors[w.anchorId] = {
        anchorId: w.anchorId,
        widgetType: w.type,
        props: { ...w.props },
        leasePolicy: w.type === 'chart' ? 'suspend-on-hide' : 'lazy',
      };
    } else {
      anchors[w.anchorId] = { ...anchors[w.anchorId], props: { ...w.props } };
    }
    if (!bindings.some((b) => b.widgetId === w.id)) {
      bindings.push({ widgetId: w.id, anchorId: w.anchorId });
    }
  }

  const regions: RegionNode[] = store.layoutRoot
    ? [store.layoutRoot]
    : widgets.map((w) => ({
        kind: 'leaf' as const,
        anchorId: w.anchorId,
        rect: { ...w.rect },
        z: w.z,
      }));

  return {
    version: LAYOUT_DOC_VERSION,
    meta,
    focusAnchorId: store.focusAnchorId ?? focusAnchorId.value,
    regions,
    anchors,
    bindings,
    tabGroups: store.tabGroups.map((g) => ({ ...g, rect: { ...g.rect } })),
    widgets,
    nextSerial: rt.nextSerial,
  };
}

function extractLayoutRoot(regions: RegionNode[] | undefined): RegionNode | null {
  if (!regions?.length) return null;
  if (regions.length === 1 && regions[0].kind === 'split') return regions[0];
  return null;
}

function applyDocument(doc: LayoutDocument, profile: WorkspaceProfile): void {
  const rt = profileRuntimes[profile];
  const widgets = doc.widgets.map((w) => sanitizeWidget(w, profile)).filter(Boolean) as WidgetState[];
  store.widgets = widgets;
  store.tabGroups = doc.tabGroups ?? [];
  store.topZ = widgets.reduce((acc, w) => Math.max(acc, w.z | 0), 1);
  store.layoutRoot = extractLayoutRoot(doc.regions);
  rt.nextSerial = Math.max(1, doc.nextSerial | 0);
  rt.layoutDocument = doc;

  const focus = doc.focusAnchorId;
  const lastChart = [...widgets].reverse().find((w) => w.type === 'chart');
  store.focusAnchorId = focus ?? lastChart?.anchorId ?? widgets[0]?.anchorId ?? null;
  setFocusAnchor(store.focusAnchorId);
}

function safeLoad(profile: WorkspaceProfile): LayoutDocument | null {
  migrateLegacyHeatmapKey();
  const slot = profile === 'futures' ? activeLayoutSlot.value : 1;

  try {
    const rawV5 = localStorage.getItem(storageKeyV5(profile, slot));
    if (rawV5) {
      const doc = parseLayoutDocument(JSON.parse(rawV5), profile);
      if (doc) return doc;
    }
  } catch {
    /* fall through */
  }

  try {
    const rawLegacy = localStorage.getItem(legacyStorageKey(profile, slot));
    if (!rawLegacy) return null;
    const legacy = parseLegacyWorkspaceLayout(JSON.parse(rawLegacy));
    if (!legacy) return null;
    const meta = layoutMetaFor(profile, slot);
    return migrateWorkspaceLayoutToDocument(legacy, meta);
  } catch {
    return null;
  }
}

function flushSave(profile = activeWorkspaceProfile.value): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const doc = buildDocumentFromStore(profile);
  profileRuntimes[profile].layoutDocument = doc;
  try {
    localStorage.setItem(storageKeyV5(profile), JSON.stringify(doc));
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
watch(() => store.tabGroups.length, scheduleSave);

function hydrateProfile(profile: WorkspaceProfile, force = false): void {
  const rt = profileRuntimes[profile];
  if (rt.hydrated && !force) return;
  const loaded = safeLoad(profile);
  if (loaded) {
    applyDocument(loaded, profile);
  } else {
    store.widgets = [];
    store.tabGroups = [];
    rt.nextSerial = 1;
    store.topZ = 1;
    store.focusAnchorId = null;
    store.layoutRoot = null;
    setFocusAnchor(null);
    rt.layoutDocument = null;
  }
  rt.hydrated = true;
}

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
  resumeSlot(profile, activeLayoutSlot.value);
}

export function switchLayoutSlot(slot: 1 | 2 | 3 | 4): void {
  if (activeWorkspaceProfile.value !== 'futures' || activeLayoutSlot.value === slot) return;
  suspendSlot('futures', activeLayoutSlot.value);
  flushSave('futures');
  activeLayoutSlot.value = slot;
  try {
    localStorage.setItem(FUTURES_SLOT_KEY, String(slot));
  } catch {
    /* ignore */
  }
  profileRuntimes.futures.hydrated = false;
  hydrateProfile('futures', true);
  resumeSlot('futures', slot);
}

export function useWorkspace() {
  if (!profileRuntimes[activeWorkspaceProfile.value].hydrated) {
    if (activeWorkspaceProfile.value === 'futures') {
      activeLayoutSlot.value = readLayoutSlot();
    }
    hydrateProfile(activeWorkspaceProfile.value);
  }

  const visibleWidgets = computed(() => {
    const { visible } = applyTabGroupVisibility(store.widgets, store.tabGroups);
    return visible;
  });

  function addWidget(
    type: WidgetType,
    rect?: Partial<WidgetRect>,
    props?: Record<string, unknown>,
  ): WidgetState | null {
    const reg = getWidget(type);
    if (!reg) return null;
    const rt = profileRuntimes[activeWorkspaceProfile.value];
    const id = `${type}-${rt.nextSerial++}`;
    const anchorId = newAnchorId();
    store.topZ++;
    const w: WidgetState = {
      id,
      anchorId,
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
    const w = store.widgets.find((x) => x.id === id);
    if (!w) return;
    releaseLease(w.anchorId);
    store.widgets = store.widgets.filter((x) => x.id !== id);
    store.tabGroups = store.tabGroups
      .map((g) => ({
        ...g,
        anchorIds: g.anchorIds.filter((a) => a !== w.anchorId),
      }))
      .filter((g) => g.anchorIds.length > 0);
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

    if (activeChartId.value && removeIds.has(activeChartId.value)) {
      const remaining = store.widgets.filter((w) => w.type === 'chart' && !removeIds.has(w.id));
      const next = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      store.focusAnchorId = next?.anchorId ?? null;
      setFocusAnchor(store.focusAnchorId);
    }

    for (const id of removeIds) {
      const w = store.widgets.find((x) => x.id === id);
      if (w) {
        snapshotPaneSettings(id, w.props as Record<string, unknown>);
        releaseLease(w.anchorId);
      }
    }

    chartPaneUnregister(chartId);
    store.widgets = store.widgets.filter((w) => !removeIds.has(w.id));
    scheduleSave();
  }

  function updateRect(id: string, rect: WidgetRect): void {
    const idx = store.widgets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const w = store.widgets[idx];
    if (w.tabGroupId) {
      const gIdx = store.tabGroups.findIndex((g) => g.groupId === w.tabGroupId);
      if (gIdx >= 0) {
        store.tabGroups[gIdx] = { ...store.tabGroups[gIdx], rect: { ...rect } };
        store.tabGroups = store.tabGroups.slice();
        scheduleSave();
      }
      return;
    }
    if (w.rect.x === rect.x && w.rect.y === rect.y && w.rect.w === rect.w && w.rect.h === rect.h) return;
    store.widgets[idx] = { ...w, rect };
    store.widgets = store.widgets.slice();
    scheduleSave();
  }

  function bringToFront(id: string): void {
    const idx = store.widgets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    store.topZ++;
    const w = store.widgets[idx];
    if (w.tabGroupId) {
      const gIdx = store.tabGroups.findIndex((g) => g.groupId === w.tabGroupId);
      if (gIdx >= 0) {
        store.tabGroups[gIdx] = { ...store.tabGroups[gIdx], z: store.topZ };
        store.tabGroups = store.tabGroups.slice();
      }
    } else {
      store.widgets[idx] = { ...w, z: store.topZ };
      store.widgets = store.widgets.slice();
    }
    scheduleSave();
  }

  function bringTabGroupToFront(groupId: string): void {
    const gIdx = store.tabGroups.findIndex((g) => g.groupId === groupId);
    if (gIdx < 0) return;
    store.topZ++;
    store.tabGroups[gIdx] = { ...store.tabGroups[gIdx], z: store.topZ };
    store.tabGroups = store.tabGroups.slice();
    scheduleSave();
  }

  function setTabGroupActive(groupId: string, activeAnchorId: string): void {
    const gIdx = store.tabGroups.findIndex((g) => g.groupId === groupId);
    if (gIdx < 0) return;
    store.tabGroups[gIdx] = { ...store.tabGroups[gIdx], activeAnchorId };
    store.tabGroups = store.tabGroups.slice();
    scheduleSave();
  }

  function createTabGroup(widgetIds: string[], rect?: Partial<WidgetRect>): TabGroupState | null {
    const members = widgetIds
      .map((id) => store.widgets.find((w) => w.id === id))
      .filter(Boolean) as WidgetState[];
    if (members.length < 2) return null;

    const groupId = newAnchorId();
    store.topZ++;
    const first = members[0];
    const group: TabGroupState = {
      groupId,
      rect: {
        x: rect?.x ?? first.rect.x,
        y: rect?.y ?? first.rect.y,
        w: rect?.w ?? first.rect.w,
        h: rect?.h ?? first.rect.h,
      },
      z: store.topZ,
      activeAnchorId: first.anchorId,
      anchorIds: members.map((m) => m.anchorId),
    };

    store.tabGroups = [...store.tabGroups, group];
    store.widgets = store.widgets.map((w) =>
      members.some((m) => m.id === w.id) ? { ...w, tabGroupId: groupId } : w,
    );
    scheduleSave();
    return group;
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

  function setLayoutRoot(root: RegionNode | null): void {
    store.layoutRoot = root;
    scheduleSave();
  }

  function onSplitRatio(path: number[], ratio: number): void {
    if (!store.layoutRoot) return;
    store.layoutRoot = mutateSplitRatio(store.layoutRoot, path, ratio);
    scheduleSave();
  }

  function splitFocusedPane(axis: 'h' | 'v'): void {
    const anchor = store.focusAnchorId;
    if (!anchor || !store.layoutRoot) return;
    const result = splitLeaf(store.layoutRoot, anchor, axis, activeWorkspaceProfile.value);
    if (!result) return;
    store.layoutRoot = result.root;
    scheduleSave();
  }

  function resetHeatmapDefaultSplit(viewportW: number, viewportH: number): void {
    if (store.widgets.length === 0) return;
    const tree = buildHeatmapDefaultTree(store.widgets, { w: viewportW, h: viewportH });
    if (tree) store.layoutRoot = tree;
    scheduleSave();
  }

  function dockWidgetToEdge(anchorId: string, edge: DockEdge, viewportW: number, viewportH: number): void {
    if (!store.layoutRoot) {
      const tree = inferSplitFromWidgets(store.widgets, { w: viewportW, h: viewportH });
      if (tree) store.layoutRoot = tree;
    }
    if (!store.layoutRoot) return;
    const next = dockToEdge(store.layoutRoot, anchorId, edge, { w: viewportW, h: viewportH });
    if (next) store.layoutRoot = next;
    scheduleSave();
  }

  function loadLayoutFromCatalog(entryId: string): boolean {
    const entry = getCatalogEntry(entryId);
    if (!entry) return false;
    importLayout(entry.document);
    return true;
  }

  function resetWorkspace(): void {
    for (const w of store.widgets) releaseLease(w.anchorId);
    store.widgets = [];
    store.tabGroups = [];
    store.layoutRoot = null;
    const rt = profileRuntimes[activeWorkspaceProfile.value];
    rt.nextSerial = 1;
    store.topZ = 1;
    store.focusAnchorId = null;
    setFocusAnchor(null);
    rt.layoutDocument = null;
    try {
      localStorage.removeItem(storageKeyV5(activeWorkspaceProfile.value));
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

  function exportCurrentLayout(name?: string): LayoutDocument {
    const doc = buildDocumentFromStore(activeWorkspaceProfile.value);
    if (name) doc.meta = { ...doc.meta, name };
    return doc;
  }

  function importLayout(doc: LayoutDocument): void {
    applyDocument(doc, activeWorkspaceProfile.value);
    scheduleSave();
  }

  function saveCurrentToCatalog(name?: string) {
    return saveLayoutToCatalog(exportCurrentLayout(), name);
  }

  function focusWidgetById(widgetId: string): void {
    const w = store.widgets.find((x) => x.id === widgetId);
    if (!w) return;
    store.focusAnchorId = w.anchorId;
    setFocusAnchor(w.anchorId);
  }

  const splitLayoutActive = computed(() => store.layoutRoot != null);

  return {
    store,
    visibleWidgets,
    splitLayoutActive,
    layoutLocked,
    activeChartId,
    focusAnchorId: computed(() => store.focusAnchorId ?? focusAnchorId.value),
    activeWorkspaceProfile,
    activeLayoutSlot,
    addWidget,
    removeWidget,
    closeChartWidget,
    updateRect,
    updateProps,
    bringToFront,
    bringTabGroupToFront,
    setTabGroupActive,
    createTabGroup,
    ensureDefaults,
    fitToViewport,
    resetWorkspace,
    findFreeSlot,
    switchLayoutSlot,
    setWorkspaceProfile,
    exportCurrentLayout,
    importLayout,
    saveCurrentToCatalog,
    focusWidgetById,
    flushSave: () => flushSave(),
    getLayoutDocument: () => buildDocumentFromStore(activeWorkspaceProfile.value),
    setLayoutRoot,
    onSplitRatio,
    splitFocusedPane,
    resetHeatmapDefaultSplit,
    dockWidgetToEdge,
    loadLayoutFromCatalog,
  };
}
