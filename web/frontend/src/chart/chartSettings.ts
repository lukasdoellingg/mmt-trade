/**
 * Workspace shell settings (tool, quote display, modal) — shared across heatmap workspace.
 * Per-chart symbol/TF/indicators live in chartPaneSettings.ts (widget.props).
 */
import { reactive, watch } from 'vue';

const STORAGE_KEY = 'mmt-chart-shell-settings-v1';

export type ChartTool = 'cursor' | 'crosshair' | 'pencil';

export interface ChartShellSettings {
  quoteUsd: boolean;
  tool: ChartTool;
  settingsModalOpen: boolean;
}

/** Full settings shape (shell + pane) for type re-exports and indicator catalog. */
export interface ChartSettings extends ChartShellSettings {
  symbol: string;
  exchange: string;
  timeframe: string;
  vwapDaily: boolean;
  vwapWeekly: boolean;
  vwapMonthly: boolean;
  vwapBands: boolean;
  ema: boolean;
  liquidations: boolean;
  obHeatmap: boolean;
  obBinMode: 'hd' | 'sd';
  obAggregate: boolean;
  obPeak: number;
  obLow: number;
  footprint: boolean;
  vpvr: boolean;
  scriptKeyLevels: boolean;
  scriptNetPositioning: boolean;
  scriptObImbalance: boolean;
}

export const TIMEFRAMES = ['1m', '15m', '30m', '1h', '4h', '1D', '1W'] as const;

const SHELL_KEYS: (keyof ChartShellSettings)[] = ['quoteUsd', 'tool', 'settingsModalOpen'];

function shellDefaults(): ChartShellSettings {
  return { quoteUsd: true, tool: 'crosshair', settingsModalOpen: false };
}

function loadShell(): ChartShellSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem('mmt-chart-settings-v1');
      if (legacy) {
        const parsed = JSON.parse(legacy) as Partial<ChartShellSettings>;
        return { ...shellDefaults(), ...pickShell(parsed) };
      }
      return shellDefaults();
    }
    const parsed = JSON.parse(raw) as Partial<ChartShellSettings>;
    return { ...shellDefaults(), ...pickShell(parsed) };
  } catch {
    return shellDefaults();
  }
}

function pickShell(parsed: Partial<ChartShellSettings>): Partial<ChartShellSettings> {
  const out: Partial<ChartShellSettings> = {};
  if (parsed.quoteUsd !== undefined) out.quoteUsd = parsed.quoteUsd;
  if (parsed.tool !== undefined) out.tool = parsed.tool;
  if (parsed.settingsModalOpen !== undefined) out.settingsModalOpen = parsed.settingsModalOpen;
  return out;
}

const state = reactive<ChartShellSettings>(loadShell());

let saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(state, () => {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }, 200);
}, { deep: true });

export function useChartSettings(): ChartShellSettings {
  return state;
}
