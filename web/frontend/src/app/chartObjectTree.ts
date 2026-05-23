/**
 * JS object tree — mirrors docs/architecture/object-tree.md for chart panes.
 * ChartRuntimeHost owns wire I/O; this module tracks mount metadata per widget.
 */
import type { ChartRuntimeAttachment, ChartWidgetRuntimeProps } from '../features/chart-runtime/chartRuntimeTypes';
import { parseChartRuntimeProps } from '../features/chart-runtime/serialize';

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
  return node;
}

export function chartPaneUnregister(widgetId: string): void {
  panes.delete(widgetId);
}

export function chartPaneSetActive(widgetId: string, active: boolean): void {
  const node = panes.get(widgetId);
  if (node) node.isActive = active;
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
  node.scriptMounts = parsed.runtimes;
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
}

export function chartPaneGet(widgetId: string): ChartPaneObjectNode | undefined {
  return panes.get(widgetId);
}
