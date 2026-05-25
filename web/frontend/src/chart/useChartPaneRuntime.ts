/**
 * Bridges chart pane object tree, widget props, and script runtime workers.
 */
import type { WidgetState } from '../workspace/types';
import type { PaneChartSettings } from '../chart/chartPaneSettings';
import { usePaneSettings } from '../chart/chartPaneSettings';
import type { ChartRuntimeAttachment } from '../features/chart-runtime/chartRuntimeTypes';
import { serializeChartRuntimeProps } from '../features/chart-runtime/serialize';
import {
  chartPaneRegister,
  chartPaneUnregister,
  chartPaneRefreshContext,
  chartPaneSyncScriptMounts,
  chartPaneUpsertMount,
  chartPaneRemoveMount,
} from '../app/chartObjectTree';
import { useScriptRuntime } from '../chart/scriptRuntime';
import { SCRIPT_INDICATORS, scriptSettingsKey, type ScriptIndicatorId } from '../indicators/indicatorCatalog';
import { USE_SESSION_MUX } from '../config/featureFlags';
import { useWorkspace } from '../workspace/useWorkspace';

/**
 * Eager create_runtime for a detached script-indicator window.
 * scopeId = window widget id (not parent chart).
 */
export function mountScriptWindowRuntime(
  windowWidgetId: string,
  parentChartId: string,
  scriptId: ScriptIndicatorId,
  localId: string,
  symbol: string,
  timeframe: string,
): string {
  if (!USE_SESSION_MUX) return '';
  const scriptRuntime = useScriptRuntime();
  const { updateProps } = useWorkspace();
  const key = scriptRuntime.mount(
    scriptId,
    symbol,
    timeframe,
    windowWidgetId,
    localId,
    'window',
    6,
    parentChartId,
  );
  const mounts = chartPaneUpsertMount(parentChartId, {
    localId,
    scriptId,
    status: 'mounting',
    pane: 'window',
    windowWidgetId,
  });
  updateProps(parentChartId, serializeChartRuntimeProps({ runtimes: mounts }));
  return key;
}

export function useChartPaneRuntime(widget: WidgetState, settings: PaneChartSettings) {
  const scriptRuntime = useScriptRuntime();
  const { updateProps, store } = useWorkspace();
  const scopeId = widget.id;

  function widgetProps(): Record<string, unknown> {
    const w = store.widgets.find((x) => x.id === scopeId);
    return (w?.props ?? widget.props) as Record<string, unknown>;
  }

  function persistMounts(mounts: ChartRuntimeAttachment[]): void {
    if (!store.widgets.some((w) => w.id === scopeId)) return;
    const next = serializeChartRuntimeProps({ runtimes: mounts });
    const cur = widgetProps().runtimes;
    if (JSON.stringify(cur) === JSON.stringify(next.runtimes)) return;
    updateProps(scopeId, next);
    chartPaneSyncScriptMounts(scopeId, { runtimes: mounts });
  }

  function registerPane(): void {
    chartPaneRegister(scopeId, settings.symbol, settings.exchange, settings.timeframe);
    chartPaneSyncScriptMounts(scopeId, widgetProps() as { runtimes?: ChartRuntimeAttachment[] });
  }

  function scriptActiveFlags(): Partial<Record<ScriptIndicatorId, boolean>> {
    const flags: Partial<Record<ScriptIndicatorId, boolean>> = {};
    for (const decl of SCRIPT_INDICATORS) {
      const sk = scriptSettingsKey(decl.id);
      if (sk) flags[decl.id] = !!(settings as unknown as Record<string, boolean>)[sk];
    }
    return flags;
  }

  function syncOverlayScripts(): void {
    if (!USE_SESSION_MUX) return;
    if (!store.widgets.some((w) => w.id === scopeId)) return;
    const sym = settings.symbol;
    const tf = settings.timeframe;
    const active = scriptActiveFlags();
    let mounts = chartPaneSyncScriptMounts(scopeId, widgetProps() as { runtimes?: ChartRuntimeAttachment[] });

    for (const decl of SCRIPT_INDICATORS) {
      const localId = decl.id;
      const key = `${scopeId}:${localId}`;
      const isOn = !!active[decl.id];
      const existing = mounts.find((m) => m.localId === localId && (m.pane ?? 'overlay') === 'overlay');

      if (isOn) {
        if (!scriptRuntime.mounts.value.has(key)) {
          scriptRuntime.mount(decl.id, sym, tf, scopeId, localId, 'overlay');
        }
        if (!existing) {
          mounts = chartPaneUpsertMount(scopeId, {
            localId,
            scriptId: decl.id,
            status: 'mounting',
            pane: 'overlay',
          });
        }
      } else {
        if (scriptRuntime.mounts.value.has(key)) scriptRuntime.unmount(key);
        if (existing) mounts = chartPaneRemoveMount(scopeId, localId);
      }
    }
    persistMounts(mounts);
  }

  function remountOnContextChange(): void {
    if (!USE_SESSION_MUX) return;
    if (!store.widgets.some((w) => w.id === scopeId)) return;
    chartPaneRefreshContext(scopeId, settings.symbol, settings.exchange, settings.timeframe);
    scriptRuntime.remountAll(scriptActiveFlags(), settings.symbol, settings.timeframe, scopeId);
    syncOverlayScripts();
  }

  function attachScriptWindow(scriptId: ScriptIndicatorId, windowWidgetId: string, localId: string): void {
    mountScriptWindowRuntime(windowWidgetId, scopeId, scriptId, localId, settings.symbol, settings.timeframe);
  }

  function detachScriptWindow(windowWidgetId: string, localId: string): void {
    const key = `${windowWidgetId}:${localId}`;
    scriptRuntime.unmount(key);
    const mounts = chartPaneRemoveMount(scopeId, localId);
    persistMounts(mounts);
  }

  function teardown(): void {
    scriptRuntime.unmountScopeOverlays(scopeId);
    chartPaneUnregister(scopeId);
  }

  return {
    scopeId,
    scriptRuntime,
    registerPane,
    syncOverlayScripts,
    remountOnContextChange,
    attachScriptWindow,
    detachScriptWindow,
    teardown,
    scriptActiveFlags,
  };
}

/** Spawn helpers for object-tree UI (ChartTopBar / ChartObjectTreePanel). */
export function spawnIndicatorWindow(
  addWidget: ReturnType<typeof useWorkspace>['addWidget'],
  findFreeSlot: ReturnType<typeof useWorkspace>['findFreeSlot'],
  viewport: { w: number; h: number },
  type: 'script-indicator-pane' | 'bar-stats',
  props: Record<string, unknown>,
  size = { w: 32, h: 28 },
  parentChartWidgetId?: string,
): WidgetState | null {
  const slot = findFreeSlot(size.w, size.h, viewport.w, viewport.h);
  const w = addWidget(type, { x: slot.x, y: slot.y, w: size.w, h: size.h }, props);
  if (!w) return null;

  const { bringToFront } = useWorkspace();
  bringToFront(w.id);

  const chartId = parentChartWidgetId ?? (props.parentChartWidgetId as string | undefined);
  if (chartId && type === 'script-indicator-pane' && USE_SESSION_MUX) {
    const pane = usePaneSettings(chartId);
    mountScriptWindowRuntime(
      w.id,
      chartId,
      props.scriptId as ScriptIndicatorId,
      props.localId as string,
      pane.symbol,
      pane.timeframe,
    );
  }

  return w;
}
