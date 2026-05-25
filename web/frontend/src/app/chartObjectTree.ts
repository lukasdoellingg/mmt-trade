/**
 * JS object tree — mirrors docs/architecture/object-tree.md for chart panes.
 * ChartRuntimeHost owns wire I/O; this module tracks mount metadata per widget.
 */
import { ref } from 'vue';
import type { ChartRuntimeAttachment, ChartWidgetRuntimeProps } from '../features/chart-runtime/chartRuntimeTypes';
import { parseChartRuntimeProps } from '../features/chart-runtime/serialize';
import type { ScriptIndicatorId } from '../indicators/indicatorCatalog';

export interface ChartPaneObjectNode {
  widgetId: string;
  paneId: number;
  symbol: string;
  exchange: string;
  timeframe: string;
  isActive: boolean;
  scriptMounts: ChartRuntimeAttachment[];
}

const panes = new Map<string, ChartPaneObjectNode>();
let nextPaneId = 1;

/** Bumped on pane/mount mutations so Vue panels can react to non-reactive Map storage. */
export const treeRevision = ref(0);

function bumpTreeRevision(): void {
  treeRevision.value++;
}

export function chartPaneRegister(
  widgetId: string,
  symbol: string,
  exchange: string,
  timeframe: string,
): ChartPaneObjectNode {
  let node = panes.get(widgetId);
  if (!node) {
    node = {
      widgetId,
      paneId: nextPaneId++,
      symbol,
      exchange,
      timeframe,
      isActive: true,
      scriptMounts: [],
    };
    panes.set(widgetId, node);
  } else {
    node.symbol = symbol;
    node.exchange = exchange;
    node.timeframe = timeframe;
    node.isActive = true;
  }
  bumpTreeRevision();
  return node;
}

export function chartPaneUnregister(widgetId: string): void {
  if (panes.delete(widgetId)) bumpTreeRevision();
}

export function chartPaneSetActive(widgetId: string, active: boolean): void {
  const node = panes.get(widgetId);
  if (node) {
    node.isActive = active;
    bumpTreeRevision();
  }
}

export function chartPaneSyncScriptMounts(
  widgetId: string,
  props: ChartWidgetRuntimeProps | undefined,
): ChartRuntimeAttachment[] {
  const node = panes.get(widgetId);
  if (!node) return [];
  const parsed = parseChartRuntimeProps(
    props as unknown as Record<string, unknown> | undefined,
  );
  node.scriptMounts = parsed.runtimes ?? [];
  bumpTreeRevision();
  return node.scriptMounts;
}

export function chartPaneRefreshContext(
  widgetId: string,
  symbol: string,
  exchange: string,
  timeframe: string,
): void {
  const node = panes.get(widgetId);
  if (!node) return;
  node.symbol = symbol;
  node.exchange = exchange;
  node.timeframe = timeframe;
  bumpTreeRevision();
}

export function chartPaneGet(widgetId: string): ChartPaneObjectNode | undefined {
  return panes.get(widgetId);
}

export function chartPaneList(): ChartPaneObjectNode[] {
  return [...panes.values()];
}

export function chartPaneUpsertMount(
  widgetId: string,
  mount: ChartRuntimeAttachment,
): ChartRuntimeAttachment[] {
  const node = panes.get(widgetId);
  if (!node) return [];
  const idx = node.scriptMounts.findIndex((m) => m.localId === mount.localId);
  if (idx >= 0) node.scriptMounts[idx] = { ...node.scriptMounts[idx], ...mount };
  else node.scriptMounts.push(mount);
  bumpTreeRevision();
  return node.scriptMounts.slice();
}

export function chartPaneRemoveMount(widgetId: string, localId: string): ChartRuntimeAttachment[] {
  const node = panes.get(widgetId);
  if (!node) return [];
  node.scriptMounts = node.scriptMounts.filter((m) => m.localId !== localId);
  bumpTreeRevision();
  return node.scriptMounts.slice();
}

export function chartPaneFindMountByRuntimeId(runtimeId: string): {
  widgetId: string;
  mount: ChartRuntimeAttachment;
} | undefined {
  for (const node of panes.values()) {
    const mount = node.scriptMounts.find((m) => m.runtimeId === runtimeId);
    if (mount) return { widgetId: node.widgetId, mount };
  }
  return undefined;
}

export function chartPaneOverlayMount(
  widgetId: string,
  scriptId: ScriptIndicatorId,
): ChartRuntimeAttachment | undefined {
  return panes.get(widgetId)?.scriptMounts.find(
    (m) => m.scriptId === scriptId && (m.pane ?? 'overlay') === 'overlay',
  );
}

export function chartPaneWindowMounts(widgetId: string): ChartRuntimeAttachment[] {
  return (panes.get(widgetId)?.scriptMounts ?? []).filter((m) => m.pane === 'window');
}
