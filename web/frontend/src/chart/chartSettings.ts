/**
 * Global chart settings shared by ChartWidget, ChartTopBar, ChartToolRail and
 * the Order-Flow widgets. Backed by a single reactive ref so all subscribers
 * stay in sync — no prop drilling.
 *
 * Persisted to localStorage so reload restores the user's indicator setup.
 */
import { reactive, watch } from 'vue';
import { DEFAULT_SYMBOL } from '../core/defaults';

const STORAGE_KEY = 'mmt-chart-settings-v1';

export type ChartTool = 'cursor' | 'crosshair' | 'pencil';

export interface ChartSettings {
  symbol: string;
  exchange: string;
  /** UI timeframe key — one of `TIMEFRAMES`. */
  timeframe: string;
  /** Indicator visibility flags. */
  vwapDaily: boolean;
  vwapWeekly: boolean;
  vwapMonthly: boolean;
  vwapBands: boolean;
  ema: boolean;
  liquidations: boolean;
  /** Layer toggles. */
  obHeatmap: boolean;
  obBinMode: 'hd' | 'sd';
  obAggregate: boolean;
  obPeak: number;
  obLow: number;
  footprint: boolean;
  vpvr: boolean;
  /** Quote-currency display switch ("$ USD" vs base symbol). */
  quoteUsd: boolean;
  /** Active tool from the left rail. */
  tool: ChartTool;
  /** Show a settings modal (handled at HeatmapView shell level). */
  settingsModalOpen: boolean;
}

export const TIMEFRAMES = ['1m', '15m', '30m', '1h', '4h', '1D', '1W'] as const;

function defaults(): ChartSettings {
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
    quoteUsd: true,
    tool: 'crosshair',
    settingsModalOpen: false,
  };
}

function loadSettings(): ChartSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<ChartSettings>;
    return { ...defaults(), ...parsed };
  } catch { return defaults(); }
}

const state = reactive<ChartSettings>(loadSettings());

let saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(state, () => {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }, 200);
}, { deep: true });

export function useChartSettings(): ChartSettings {
  return state;
}
