/**
 * MMT.gg-style indicator declarations — native layers vs script runtimes.
 * Script ids must match backend `SCRIPT_IDS` in runtimeLimits.js.
 */
export const SCRIPT_INDICATOR_IDS = ['key-levels', 'net-positioning', 'aggregated-ob-imbalance'] as const;

export type ScriptIndicatorId = (typeof SCRIPT_INDICATOR_IDS)[number];

/** Where the indicator renders (MMT object-tree mount kind). */
export type IndicatorMountKind = 'native' | 'script';

/** overlay = price lines on chart; window = separate workspace widget. */
export type IndicatorPaneKind = 'overlay' | 'window';

export interface NativeIndicatorDecl {
  kind: 'native';
  id: string;
  label: string;
  /** chartSettings boolean key */
  settingsKey:
    | 'vwapDaily'
    | 'vwapWeekly'
    | 'vwapMonthly'
    | 'vwapBands'
    | 'ema'
    | 'liquidations'
    | 'obHeatmap'
    | 'footprint'
    | 'vpvr';
  pane: 'overlay';
}

export interface ScriptIndicatorDecl {
  kind: 'script';
  id: ScriptIndicatorId;
  label: string;
  color: string;
  /** Default placement when toggled on chart pane. */
  defaultPane: IndicatorPaneKind;
  /** Workspace widget type when opened as its own window. */
  windowWidgetType: 'script-indicator-pane' | 'bar-stats';
}

export type IndicatorDecl = NativeIndicatorDecl | ScriptIndicatorDecl;

export const NATIVE_INDICATORS: NativeIndicatorDecl[] = [
  { kind: 'native', id: 'vwap-d', label: 'VWAP Daily', settingsKey: 'vwapDaily', pane: 'overlay' },
  { kind: 'native', id: 'vwap-w', label: 'VWAP Weekly', settingsKey: 'vwapWeekly', pane: 'overlay' },
  { kind: 'native', id: 'vwap-m', label: 'VWAP Monthly', settingsKey: 'vwapMonthly', pane: 'overlay' },
  { kind: 'native', id: 'vwap-bands', label: 'VWAP σ bands', settingsKey: 'vwapBands', pane: 'overlay' },
  { kind: 'native', id: 'ema', label: 'EMA 9/21', settingsKey: 'ema', pane: 'overlay' },
  { kind: 'native', id: 'liquidations', label: 'Liquidations', settingsKey: 'liquidations', pane: 'overlay' },
  { kind: 'native', id: 'ob-heatmap', label: 'OB Heatmap', settingsKey: 'obHeatmap', pane: 'overlay' },
  { kind: 'native', id: 'footprint', label: 'Footprint', settingsKey: 'footprint', pane: 'overlay' },
  { kind: 'native', id: 'vpvr', label: 'VPVR', settingsKey: 'vpvr', pane: 'overlay' },
];

export const SCRIPT_INDICATORS: ScriptIndicatorDecl[] = [
  {
    kind: 'script',
    id: 'key-levels',
    label: 'Key Levels',
    color: '#6eb5ff',
    defaultPane: 'overlay',
    windowWidgetType: 'script-indicator-pane',
  },
  {
    kind: 'script',
    id: 'net-positioning',
    label: 'Net Positioning',
    color: '#c86eff',
    defaultPane: 'overlay',
    windowWidgetType: 'script-indicator-pane',
  },
  {
    kind: 'script',
    id: 'aggregated-ob-imbalance',
    label: 'OB Imbalance',
    color: '#3fd3a0',
    defaultPane: 'overlay',
    windowWidgetType: 'script-indicator-pane',
  },
];

export const SCRIPT_INDICATOR_LABELS: Record<ScriptIndicatorId, string> = {
  'key-levels': 'Key Levels',
  'net-positioning': 'Net Positioning',
  'aggregated-ob-imbalance': 'OB Imbalance',
};

export const SCRIPT_INDICATOR_COLORS: Record<ScriptIndicatorId, string> = {
  'key-levels': '#6eb5ff',
  'net-positioning': '#c86eff',
  'aggregated-ob-imbalance': '#3fd3a0',
};

/** Bar stats stream (stream 13) — separate window, not create_runtime. */
export const BAR_STATS_DECL: ScriptIndicatorDecl = {
  kind: 'script',
  id: 'key-levels',
  label: 'Bar Stats',
  color: '#e8c46a',
  defaultPane: 'window',
  windowWidgetType: 'bar-stats',
};

export function scriptDeclById(id: ScriptIndicatorId): ScriptIndicatorDecl | undefined {
  return SCRIPT_INDICATORS.find((d) => d.id === id);
}

import type { ChartSettings } from '../chart/chartSettings';

export function scriptSettingsKey(id: ScriptIndicatorId): keyof ChartSettings | null {
  switch (id) {
    case 'key-levels':
      return 'scriptKeyLevels';
    case 'net-positioning':
      return 'scriptNetPositioning';
    case 'aggregated-ob-imbalance':
      return 'scriptObImbalance';
    default:
      return null;
  }
}
