/**
 * Key Levels overlay labels — mirrors backend KEY_LEVEL_ROLE in keyLevels.js.
 */
import type { ScriptPlotOverlayLine } from '../chart/ChartOverlayRenderer';

/** u8 role ids (must match web/backend/lib/indicators/keyLevels.js). */
export const KEY_LEVEL_ROLE = {
  PIVOT_HIGH: 1,
  PIVOT_LOW: 2,
  PREV_HIGH: 3,
  PREV_LOW: 4,
  PREV_CLOSE: 5,
  SESSION_HIGH: 6,
  SESSION_LOW: 7,
  PIVOT_R1: 8,
  PIVOT_S1: 9,
  PIVOT_R2: 10,
  PIVOT_S2: 11,
  ROUND: 12,
  LAST: 13,
  PIVOT_MID: 14,
} as const;

const ROLE_LABEL: Record<number, string> = {
  [KEY_LEVEL_ROLE.PIVOT_HIGH]: 'Swing H',
  [KEY_LEVEL_ROLE.PIVOT_LOW]: 'Swing L',
  [KEY_LEVEL_ROLE.PREV_HIGH]: 'PDH',
  [KEY_LEVEL_ROLE.PREV_LOW]: 'PDL',
  [KEY_LEVEL_ROLE.PREV_CLOSE]: 'PDC',
  [KEY_LEVEL_ROLE.SESSION_HIGH]: 'Sess H',
  [KEY_LEVEL_ROLE.SESSION_LOW]: 'Sess L',
  [KEY_LEVEL_ROLE.PIVOT_R1]: 'R1',
  [KEY_LEVEL_ROLE.PIVOT_S1]: 'S1',
  [KEY_LEVEL_ROLE.PIVOT_R2]: 'R2',
  [KEY_LEVEL_ROLE.PIVOT_S2]: 'S2',
  [KEY_LEVEL_ROLE.ROUND]: 'Round',
  [KEY_LEVEL_ROLE.LAST]: 'Last',
  [KEY_LEVEL_ROLE.PIVOT_MID]: 'P',
};

const RESISTANCE_ROLES: Set<number> = new Set([
  KEY_LEVEL_ROLE.PIVOT_HIGH,
  KEY_LEVEL_ROLE.PREV_HIGH,
  KEY_LEVEL_ROLE.SESSION_HIGH,
  KEY_LEVEL_ROLE.PIVOT_R1,
  KEY_LEVEL_ROLE.PIVOT_R2,
]);

const SUPPORT_ROLES: Set<number> = new Set([
  KEY_LEVEL_ROLE.PIVOT_LOW,
  KEY_LEVEL_ROLE.PREV_LOW,
  KEY_LEVEL_ROLE.SESSION_LOW,
  KEY_LEVEL_ROLE.PIVOT_S1,
  KEY_LEVEL_ROLE.PIVOT_S2,
]);

export function keyLevelColor(role: number, fallback = '#6eb5ff'): string {
  if (RESISTANCE_ROLES.has(role)) return '#ff7a9a';
  if (SUPPORT_ROLES.has(role)) return '#6eb5ff';
  if (role === KEY_LEVEL_ROLE.PIVOT_MID || role === KEY_LEVEL_ROLE.PREV_CLOSE) return '#e8c46a';
  if (role === KEY_LEVEL_ROLE.LAST) return '#b8c8d8';
  if (role === KEY_LEVEL_ROLE.ROUND) return '#5a6878';
  return fallback;
}

function fmtCompact(price: number): string {
  if (price >= 10_000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

function roleLabel(role: number): string {
  return ROLE_LABEL[role] ?? 'Lvl';
}

/**
 * Build overlay lines for key-levels script mount (labels thinned to avoid clutter).
 */
export function buildKeyLevelPlotLines(
  prices: Float64Array | number[] | null,
  roles: Uint8Array | null | undefined,
  midPrice: number,
  maxLabels = 10,
): ScriptPlotOverlayLine[] {
  if (!prices?.length) return [];
  const n = prices.length;
  const lines: ScriptPlotOverlayLine[] = [];
  let labelBudget = maxLabels;

  for (let i = 0; i < n; i++) {
    const price = prices[i];
    if (!(price > 0)) continue;
    const role = roles && i < roles.length ? roles[i] : 0;
    const color = keyLevelColor(role);
    let label: string | undefined;
    const isMajor =
      role === KEY_LEVEL_ROLE.PREV_HIGH ||
      role === KEY_LEVEL_ROLE.PREV_LOW ||
      role === KEY_LEVEL_ROLE.PIVOT_R1 ||
      role === KEY_LEVEL_ROLE.PIVOT_S1 ||
      role === KEY_LEVEL_ROLE.SESSION_HIGH ||
      role === KEY_LEVEL_ROLE.SESSION_LOW;
    if (labelBudget > 0 && (isMajor || labelBudget > n - i)) {
      label = `${roleLabel(role)} ${fmtCompact(price)}`;
      labelBudget--;
    }
    lines.push({ price, color, label, role });
  }

  lines.sort((a, b) => a.price - b.price);
  return lines;
}

export function keyLevelRowLabel(price: number, role: number): string {
  return `${roleLabel(role)} · ${fmtCompact(price)}`;
}
