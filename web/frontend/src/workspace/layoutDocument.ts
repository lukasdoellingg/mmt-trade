/**
 * LayoutDocument v5 — migration, flatten, and serialize helpers.
 */
import type {
  LayoutDocument,
  LayoutDocumentMeta,
  PaneAnchor,
  TabGroupState,
  WidgetBinding,
  WidgetRect,
  WidgetState,
  WidgetType,
  WorkspaceLayout,
  WorkspaceProfile,
} from './types';

export const LAYOUT_DOC_VERSION = 5 as const;
export const LEGACY_LAYOUT_VERSION = 4 as const;

export function newAnchorId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `anchor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultLeasePolicy(widgetType: WidgetType): PaneAnchor['leasePolicy'] {
  return widgetType === 'chart' ? 'suspend-on-hide' : 'lazy';
}

export function ensureWidgetAnchor(w: WidgetState): WidgetState {
  const anchorId =
    typeof w.anchorId === 'string' && w.anchorId.length > 0 ? w.anchorId : newAnchorId();
  if (w.anchorId === anchorId) return w;
  return { ...w, anchorId };
}

/** v4 flat layout → v5 LayoutDocument. */
export function migrateWorkspaceLayoutToDocument(
  layout: WorkspaceLayout,
  meta: LayoutDocumentMeta,
  focusAnchorId: string | null = null,
): LayoutDocument {
  const anchors: Record<string, PaneAnchor> = {};
  const bindings: WidgetBinding[] = [];
  const widgets = layout.widgets.map((raw) => {
    const w = ensureWidgetAnchor(raw);
    anchors[w.anchorId] = {
      anchorId: w.anchorId,
      widgetType: w.type,
      props: { ...(w.props ?? {}) },
      leasePolicy: defaultLeasePolicy(w.type),
    };
    bindings.push({ widgetId: w.id, anchorId: w.anchorId });
    return w;
  });

  const regions = widgets.map((w) => ({
    kind: 'leaf' as const,
    anchorId: w.anchorId,
    rect: { ...w.rect },
    z: w.z,
  }));

  let focus = focusAnchorId;
  if (!focus) {
    const lastChart = [...widgets].reverse().find((x) => x.type === 'chart');
    focus = lastChart?.anchorId ?? widgets[0]?.anchorId ?? null;
  }

  return {
    version: LAYOUT_DOC_VERSION,
    meta,
    focusAnchorId: focus,
    regions,
    anchors,
    bindings,
    tabGroups: [],
    widgets,
    nextSerial: layout.nextSerial,
  };
}

export function layoutMetaFor(
  profile: WorkspaceProfile,
  slot: 1 | 2 | 3 | 4,
  name?: string,
): LayoutDocumentMeta {
  return {
    name: name ?? (profile === 'heatmap' ? 'Heatmap' : `Futures ${slot}`),
    profile,
    slot: profile === 'futures' ? slot : undefined,
  };
}

/** Strip to v4-compatible snapshot (widgets + nextSerial). */
export function documentToWorkspaceLayout(doc: LayoutDocument): WorkspaceLayout {
  return {
    version: LEGACY_LAYOUT_VERSION,
    widgets: doc.widgets.map((w) => ({
      id: w.id,
      anchorId: w.anchorId,
      type: w.type,
      rect: { ...w.rect },
      z: w.z,
      props: w.props,
      tabGroupId: w.tabGroupId,
    })),
    nextSerial: doc.nextSerial,
  };
}

export function parseLayoutDocument(raw: unknown, profile: WorkspaceProfile): LayoutDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Partial<LayoutDocument>;
  if (j.version !== LAYOUT_DOC_VERSION || !Array.isArray(j.widgets)) return null;

  const widgets = j.widgets
    .map((w) => (w && typeof w === 'object' ? ensureWidgetAnchor(w as WidgetState) : null))
    .filter(Boolean) as WidgetState[];

  if (!widgets.length) return null;

  const meta = j.meta ?? layoutMetaFor(profile, 1);
  const anchors: Record<string, PaneAnchor> = { ...(j.anchors ?? {}) };
  const bindings: WidgetBinding[] = Array.isArray(j.bindings) ? [...j.bindings] : [];

  for (const w of widgets) {
    if (!anchors[w.anchorId]) {
      anchors[w.anchorId] = {
        anchorId: w.anchorId,
        widgetType: w.type,
        props: { ...(w.props ?? {}) },
        leasePolicy: defaultLeasePolicy(w.type),
      };
    }
    if (!bindings.some((b) => b.widgetId === w.id)) {
      bindings.push({ widgetId: w.id, anchorId: w.anchorId });
    }
  }

  return {
    version: LAYOUT_DOC_VERSION,
    meta,
    focusAnchorId: j.focusAnchorId ?? null,
    regions: Array.isArray(j.regions) ? j.regions : [],
    anchors,
    bindings,
    tabGroups: Array.isArray(j.tabGroups) ? j.tabGroups : [],
    widgets,
    nextSerial: Math.max(1, (j.nextSerial as number) | 0),
  };
}

export function parseLegacyWorkspaceLayout(raw: unknown): WorkspaceLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as WorkspaceLayout;
  if (j.version !== LEGACY_LAYOUT_VERSION || !Array.isArray(j.widgets)) return null;
  return {
    version: LEGACY_LAYOUT_VERSION,
    widgets: j.widgets.map((w) => ensureWidgetAnchor(w)),
    nextSerial: Math.max(1, j.nextSerial | 0),
  };
}

/** Apply tab group geometry: inactive members hidden via rect clone at group rect. */
export function applyTabGroupVisibility(
  widgets: WidgetState[],
  tabGroups: TabGroupState[],
): { visible: WidgetState[]; hiddenAnchorIds: Set<string> } {
  if (!tabGroups.length) {
    return { visible: widgets, hiddenAnchorIds: new Set() };
  }

  const hiddenAnchorIds = new Set<string>();
  const groupById = new Map(tabGroups.map((g) => [g.groupId, g]));
  const visible: WidgetState[] = [];

  for (const g of tabGroups) {
    for (const aid of g.anchorIds) {
      if (aid !== g.activeAnchorId) hiddenAnchorIds.add(aid);
    }
  }

  for (const w of widgets) {
    if (!w.tabGroupId) {
      visible.push(w);
      continue;
    }
    const g = groupById.get(w.tabGroupId);
    if (!g) {
      visible.push(w);
      continue;
    }
    if (w.anchorId !== g.activeAnchorId) continue;
    visible.push({
      ...w,
      rect: { ...g.rect },
      z: g.z,
    });
  }

  return { visible, hiddenAnchorIds };
}

export function mergeTabGroup(
  doc: LayoutDocument,
  group: TabGroupState,
): LayoutDocument {
  const tabGroups = [...(doc.tabGroups ?? [])];
  const idx = tabGroups.findIndex((g) => g.groupId === group.groupId);
  if (idx >= 0) tabGroups[idx] = group;
  else tabGroups.push(group);
  return { ...doc, tabGroups };
}

export function widgetRectForGroupMember(
  w: WidgetState,
  tabGroups: TabGroupState[],
): WidgetRect {
  if (!w.tabGroupId) return w.rect;
  const g = tabGroups.find((t) => t.groupId === w.tabGroupId);
  if (!g || w.anchorId !== g.activeAnchorId) return w.rect;
  return { ...g.rect };
}
