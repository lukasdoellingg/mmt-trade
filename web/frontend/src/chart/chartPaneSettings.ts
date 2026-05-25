/**
 * Per-chart-widget settings stored in workspace widget.props.
 * Shell-level UI (tool, quoteUsd, modal) stays in chartSettings.ts.
 */
import { computed, reactive } from 'vue';
import { DEFAULT_SYMBOL } from '../core/defaults';
import { useWorkspace } from '../workspace/useWorkspace';
import type { ChartSettings } from './chartSettings';

const LEGACY_STORAGE_KEY = 'mmt-chart-settings-v1';

export type PaneChartSettings = Pick<
  ChartSettings,
  | 'symbol'
  | 'exchange'
  | 'timeframe'
  | 'vwapDaily'
  | 'vwapWeekly'
  | 'vwapMonthly'
  | 'vwapBands'
  | 'ema'
  | 'liquidations'
  | 'obHeatmap'
  | 'obBinMode'
  | 'obAggregate'
  | 'obPeak'
  | 'obLow'
  | 'footprint'
  | 'vpvr'
  | 'scriptKeyLevels'
  | 'scriptNetPositioning'
  | 'scriptObImbalance'
>;

const PANE_KEYS: (keyof PaneChartSettings)[] = [
  'symbol', 'exchange', 'timeframe',
  'vwapDaily', 'vwapWeekly', 'vwapMonthly', 'vwapBands',
  'ema', 'liquidations',
  'obHeatmap', 'obBinMode', 'obAggregate', 'obPeak', 'obLow',
  'footprint', 'vpvr',
  'scriptKeyLevels', 'scriptNetPositioning', 'scriptObImbalance',
];

export function paneDefaults(): PaneChartSettings {
  return {
    symbol: DEFAULT_SYMBOL,
    exchange: 'Binance',
    timeframe: '1h',
    vwapDaily: true,
    vwapWeekly: true,
    vwapMonthly: true,
    vwapBands: true,
    ema: true,
    liquidations: true,
    obHeatmap: true,
    obBinMode: 'hd',
    obAggregate: false,
    obPeak: 1.0,
    obLow: 0,
    footprint: false,
    vpvr: false,
    scriptKeyLevels: false,
    scriptNetPositioning: false,
    scriptObImbalance: false,
  };
}

function loadLegacyGlobal(): Partial<PaneChartSettings> {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<PaneChartSettings> = {};
    for (const k of PANE_KEYS) {
      if (k in parsed) (out as Record<string, unknown>)[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

function pickPaneProps(props: Record<string, unknown>): PaneChartSettings {
  const base = { ...paneDefaults(), ...loadLegacyGlobal() };
  for (const k of PANE_KEYS) {
    if (k in props && props[k] !== undefined) {
      (base as Record<string, unknown>)[k] = props[k];
    }
  }
  return base;
}

/** Initial props for a new chart widget (includes one-time legacy migration). */
export function initialChartWidgetProps(): Record<string, unknown> {
  return { ...paneDefaults(), ...loadLegacyGlobal() };
}

function resolveActiveChartId(
  store: { widgets: { id: string; type: string }[] },
  activeChartId: { value: string | null },
): string | null {
  return activeChartId.value
    ?? store.widgets.find((w) => w.type === 'chart')?.id
    ?? null;
}

function paneProxy(
  widgetId: () => string | null,
  store: ReturnType<typeof useWorkspace>['store'],
  updateProps: ReturnType<typeof useWorkspace>['updateProps'],
): PaneChartSettings {
  return reactive(
    new Proxy({} as PaneChartSettings, {
      get(_, prop: keyof PaneChartSettings) {
        const id = widgetId();
        if (!id) return paneDefaults()[prop];
        const w = store.widgets.find((x) => x.id === id);
        const p = (w?.props ?? {}) as Record<string, unknown>;
        const v = p[prop as string];
        return (v !== undefined ? v : paneDefaults()[prop]) as PaneChartSettings[typeof prop];
      },
      set(_, prop: keyof PaneChartSettings, value) {
        const id = widgetId();
        if (!id) return true;
        updateProps(id, { [prop]: value });
        return true;
      },
    }),
  );
}

/** Reactive pane settings for one chart widget (reads/writes widget.props). */
export function usePaneSettings(widgetId: string): PaneChartSettings {
  const { store, updateProps } = useWorkspace();
  return paneProxy(() => widgetId, store, updateProps);
}

/** Active chart pane for ChartTopBar / tool rail (last focused chart). */
export function useActivePaneSettings(): PaneChartSettings {
  const { store, activeChartId, updateProps } = useWorkspace();
  return paneProxy(
    () => resolveActiveChartId(store, activeChartId),
    store,
    updateProps,
  );
}

/** Read-only snapshot of active pane (for computed titles). */
export function activePaneSnapshot(): PaneChartSettings | null {
  const { store, activeChartId } = useWorkspace();
  const id = resolveActiveChartId(store, activeChartId);
  if (!id) return null;
  const w = store.widgets.find((x) => x.id === id);
  if (!w || w.type !== 'chart') return null;
  return pickPaneProps((w.props ?? {}) as Record<string, unknown>);
}
