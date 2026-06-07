/**
 * Workspace / widget-grid type definitions.
 *
 * LCM v5: each widget carries a stable `anchorId` (UUID) for runtime leases.
 * Layout geometry lives in `widgets[]` + optional `tabGroups[]`.
 */

export type WidgetType =
  | 'chart'
  | 'orderflow-ladder'
  | 'bar-stats'
  | 'script-indicator-pane'
  | 'coin-scanner'
  | 'futures-metric-pane';

export type FuturesMetricKind =
  | 'funding'
  | 'oi-snap'
  | 'oi-hist'
  | 'cvd'
  | 'liquidations'
  | 'basis'
  | 'volume'
  | 'returns-hour'
  | 'returns-day'
  | 'returns-cum';

export type WorkspaceProfile = 'heatmap' | 'futures';

export type LeasePolicy = 'eager' | 'lazy' | 'suspend-on-hide';

export type LeaseState = 'cold' | 'booting' | 'active' | 'suspended' | 'released';

export interface WidgetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetState<P = Record<string, unknown>> {
  id: string;
  /** Stable pane identity for runtime leases (LCM). */
  anchorId: string;
  type: WidgetType;
  rect: WidgetRect;
  /** Stable rendering order (small = behind). */
  z: number;
  /** When set, widget renders only when active tab in group. */
  tabGroupId?: string;
  /** Widget-specific persistent options (PG, USD/BASE toggle, etc.). */
  props: P;
}

/** Legacy v4 persisted shape (still accepted on load). */
export interface WorkspaceLayout {
  version: number;
  widgets: WidgetState[];
  nextSerial: number;
}

export interface LayoutDocumentMeta {
  name: string;
  profile: WorkspaceProfile;
  slot?: 1 | 2 | 3 | 4;
}

export interface PaneAnchor {
  anchorId: string;
  widgetType: WidgetType;
  props: Record<string, unknown>;
  leasePolicy: LeasePolicy;
}

export interface WidgetBinding {
  widgetId: string;
  anchorId: string;
}

export type RegionNode =
  | { kind: 'leaf'; anchorId: string; rect: WidgetRect; z: number }
  | { kind: 'tabs'; activeAnchorId: string; anchorIds: string[]; rect: WidgetRect; z: number }
  | { kind: 'split'; axis: 'h' | 'v'; ratio: number; a: RegionNode; b: RegionNode };

export interface TabGroupState {
  groupId: string;
  rect: WidgetRect;
  z: number;
  activeAnchorId: string;
  anchorIds: string[];
  title?: string;
}

/** LCM v5 — full layout document. */
export interface LayoutDocument {
  version: 5;
  meta: LayoutDocumentMeta;
  focusAnchorId: string | null;
  regions: RegionNode[];
  anchors: Record<string, PaneAnchor>;
  bindings: WidgetBinding[];
  tabGroups: TabGroupState[];
  widgets: WidgetState[];
  nextSerial: number;
}

export interface LayoutCatalogEntry {
  id: string;
  name: string;
  profile: WorkspaceProfile;
  slot?: 1 | 2 | 3 | 4;
  updatedAt: number;
  document: LayoutDocument;
}

export interface WidgetRegistryEntry {
  componentName: string;
  defaultSize: { w: number; h: number };
  defaultProps: () => Record<string, unknown>;
  label: string;
}

export interface RuntimeLeaseRecord {
  anchorId: string;
  widgetId: string | null;
  widgetType: WidgetType;
  state: LeaseState;
  slotKey: string | null;
}
